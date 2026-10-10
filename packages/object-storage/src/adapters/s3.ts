import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  defineProvider,
  guardObjectStorage,
  OBJECT_LIST_PAGE_SIZE,
  ObjectNotFound,
  ObjectStorageUnavailable,
  secretRef,
  type ObjectBody,
  type ObjectPutOptions,
  type ObjectStorage,
  type ObjectStorageFailure,
  type ProviderCheckContext,
  type ProviderCheckResult
} from "@vivd-catalyst/core";

/**
 * The transport bounds of a check's own request: how long the connection may take and how long
 * the store may leave the request unanswered. Both end before `PROVIDER_CHECK_TIMEOUT_MS`, so a
 * stalled store frees its socket by itself even where the abort of the check is not heard.
 */
const S3_CHECK_CONNECTION_TIMEOUT_MS = 2_000;
const S3_CHECK_REQUEST_TIMEOUT_MS = 4_000;

/** The check of each store this adapter created. A store of another adapter has none. */
const checksOfStores = new WeakMap<
  ObjectStorage,
  (context: ProviderCheckContext) => Promise<ProviderCheckResult>
>();

const s3ConfigSchema = z.object({
  bucket: z.string().min(1).default("vivd-catalyst-documents"),
  /** The vendor's own region name. The product `region` of the entry is a different key. */
  bucketRegion: z.string().min(1).default("us-east-1"),
  endpoint: z.string().url().optional(),
  forcePathStyle: z.boolean().default(true),
  accessKeySecret: secretRef().default("AWS_ACCESS_KEY_ID"),
  secretKeySecret: secretRef().default("AWS_SECRET_ACCESS_KEY")
});

/** Any S3-compatible object store. A key is the object's key in the bucket, unchanged. */
export const s3ObjectStorageProvider = defineProvider({
  port: "objectStorage",
  type: "s3",
  configSchema: s3ConfigSchema,
  external: true,
  async create(config, { secrets, entryPath }): Promise<ObjectStorage> {
    const clientConfig = {
      region: config.bucketRegion,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: await secrets.resolve(config.accessKeySecret),
        secretAccessKey: await secrets.resolve(config.secretKeySecret)
      }
    };
    const storage = guardObjectStorage(
      new S3ObjectStorage(config.bucket, new S3Client(clientConfig)),
      { entryPath }
    );
    // The check has a client of its own: one attempt inside tight transport bounds, which the
    // product's reads and writes of large objects must not have. It opens no connection until
    // a check runs.
    const checkClient = new S3Client({
      ...clientConfig,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: S3_CHECK_CONNECTION_TIMEOUT_MS,
        requestTimeout: S3_CHECK_REQUEST_TIMEOUT_MS
      }
    });
    checksOfStores.set(storage, ({ signal }) => checkBucket(checkClient, config.bucket, signal));
    return storage;
  },
  async check(storage, context) {
    return (await checksOfStores.get(storage)?.(context)) ?? { ok: false, errorClass: "failed" };
  },
  describe(config) {
    return {
      bucket: config.bucket,
      bucketRegion: config.bucketRegion,
      ...(config.endpoint ? { endpointHost: new URL(config.endpoint).host } : {})
    };
  }
});

/**
 * Whether the bucket answers: one HEAD of the bucket, which reads and never writes. It does not
 * go through the store's own requests, which create a missing bucket: a check that finds none
 * says so and leaves the store as it is. The signal ends the request when the check's time is up.
 */
async function checkBucket(
  client: S3Client,
  bucket: string,
  signal: AbortSignal
): Promise<ProviderCheckResult> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
    return { ok: true };
  } catch (error: unknown) {
    if (signal.aborted) {
      return { ok: false, errorClass: "timeout" };
    }
    const code = codeOf(error);
    if (code === "TimeoutError" || code === "ETIMEDOUT" || code === "RequestTimeout") {
      return { ok: false, errorClass: "timeout" };
    }
    switch (failureOf(code, statusOf(error))) {
      case "store_missing":
        return { ok: false, errorClass: "bucket_missing" };
      case "access_denied":
        return { ok: false, errorClass: "access_denied" };
      case "unreachable":
        return { ok: false, errorClass: "unreachable" };
      default:
        return { ok: false, errorClass: "failed" };
    }
  }
}

/** How many objects a prefix delete removes at the same time. */
const PREFIX_DELETE_CONCURRENCY = 8;

/** Error codes of the vendor and of the network that may leave this adapter. */
const REPORTED_CODES = new Set([
  "AccessDenied",
  "NoSuchBucket",
  "NoSuchKey",
  "NotFound",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "SlowDown",
  "ServiceUnavailable",
  "InternalError",
  "RequestTimeout",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "TimeoutError"
]);

/** Whether a missing answer means the object or the bucket. */
type S3RequestTarget = "object" | "store";

class S3ObjectStorage implements ObjectStorage {
  private bucketReady: Promise<void> | undefined;

  constructor(
    private readonly bucket: string,
    private readonly client: S3Client
  ) {}

  async put(key: string, body: ObjectBody, options?: ObjectPutOptions): Promise<void> {
    await this.request("store", () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body instanceof Uint8Array ? body : Readable.from(body),
          ContentType: options?.contentType,
          ContentLength: options?.size
        })
      )
    );
  }

  async get(key: string) {
    const response = await this.request("object", () =>
      this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    );
    const body = response.Body;
    if (!(body instanceof Readable) || response.ContentLength === undefined) {
      throw new ObjectStorageUnavailable("request_failed");
    }
    return {
      size: response.ContentLength,
      ...(response.ContentType ? { contentType: response.ContentType } : {}),
      body: readChunks(body)
    };
  }

  async head(key: string) {
    const response = await this.request("object", () =>
      this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
    );
    if (response.ContentLength === undefined) {
      throw new ObjectStorageUnavailable("request_failed");
    }
    return {
      size: response.ContentLength,
      ...(response.ContentType ? { contentType: response.ContentType } : {})
    };
  }

  async delete(key: string): Promise<void> {
    await this.request("store", () =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    );
  }

  async deletePrefix(prefix: string): Promise<{ deleted: number }> {
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const page = await this.list(prefix, cursor);
      const keys = page.objects.map((object) => object.key);
      for (let start = 0; start < keys.length; start += PREFIX_DELETE_CONCURRENCY) {
        const batch = keys.slice(start, start + PREFIX_DELETE_CONCURRENCY);
        await Promise.all(batch.map((key) => this.delete(key)));
        deleted += batch.length;
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return { deleted };
  }

  async list(prefix: string, cursor?: string) {
    const response = await this.request("store", () =>
      this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: OBJECT_LIST_PAGE_SIZE,
          ContinuationToken: cursor
        })
      )
    );
    const objects = (response.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [{ key: object.Key, size: object.Size ?? 0 }]
    );
    return {
      objects,
      ...(response.IsTruncated && response.NextContinuationToken
        ? { cursor: response.NextContinuationToken }
        : {})
    };
  }

  /** Signs locally; no request leaves the process. */
  async signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: ttlSeconds }
      );
    } catch (error: unknown) {
      throw s3PortError(error, "store");
    }
  }

  private async request<Result>(
    target: S3RequestTarget,
    send: () => Promise<Result>
  ): Promise<Result> {
    try {
      await this.ensureBucket();
      return await send();
    } catch (error: unknown) {
      throw s3PortError(error, target);
    }
  }

  private ensureBucket(): Promise<void> {
    this.bucketReady ??= this.ensureBucketOnce().catch((error: unknown) => {
      // The next request asks again, so a store that comes back is found.
      this.bucketReady = undefined;
      throw s3PortError(error, "store");
    });
    return this.bucketReady;
  }

  /** Creates the bucket when it is missing, which is how a local S3 mock gets its bucket. */
  private async ensureBucketOnce(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error: unknown) {
      if (codeOf(error) !== "NoSuchBucket" && statusOf(error) !== 404) {
        throw error;
      }
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error: unknown) {
      const code = codeOf(error);
      if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") {
        throw error;
      }
    }
  }
}

async function* readChunks(body: Readable): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of body) {
      if (chunk instanceof Uint8Array) {
        yield chunk;
      }
    }
  } catch (error: unknown) {
    throw s3PortError(error, "object");
  }
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  for (const field of ["Code", "code", "name"]) {
    const value: unknown = Reflect.get(error, field);
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const metadata: unknown = Reflect.get(error, "$metadata");
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const status: unknown = Reflect.get(metadata, "httpStatusCode");
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/**
 * The port's error for a vendor or network failure. Only a code from the closed list and the
 * HTTP status are kept: the vendor's message can repeat a key, a bucket or a signed address.
 */
function s3PortError(error: unknown, target: S3RequestTarget): Error {
  if (error instanceof ObjectNotFound || error instanceof ObjectStorageUnavailable) {
    return error;
  }
  const code = codeOf(error);
  const status = statusOf(error);
  if (target === "object" && code !== "NoSuchBucket" && (code === "NoSuchKey" || status === 404)) {
    return new ObjectNotFound();
  }
  return new ObjectStorageUnavailable(failureOf(code, status), {
    ...(code && REPORTED_CODES.has(code) ? { providerErrorCode: code } : {}),
    ...(status !== undefined ? { httpStatusCode: status } : {})
  });
}

function failureOf(code: string | undefined, status: number | undefined): ObjectStorageFailure {
  if (code === "NoSuchBucket" || status === 404) {
    return "store_missing";
  }
  if (
    code === "AccessDenied" ||
    code === "InvalidAccessKeyId" ||
    code === "SignatureDoesNotMatch" ||
    status === 401 ||
    status === 403
  ) {
    return "access_denied";
  }
  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "TimeoutError"
  ) {
    return "unreachable";
  }
  return "request_failed";
}

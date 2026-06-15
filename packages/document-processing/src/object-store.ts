import {
  DeleteObjectCommand,
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import type { DocumentObjectStorageConfig } from "@vivd-catalyst/core";

export interface ObjectStorePutInput {
  key: string;
  body: Uint8Array;
  contentType?: string;
}

export interface ObjectStore {
  putObject(input: ObjectStorePutInput): Promise<void>;
  getObject(key: string): Promise<Uint8Array>;
  deleteObject?(key: string): Promise<void>;
}

export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async putObject(input: ObjectStorePutInput): Promise<void> {
    this.objects.set(input.key, input.body);
  }

  async getObject(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Object '${key}' is not available`);
    }
    return object;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export interface S3ObjectStoreOptions {
  config: DocumentObjectStorageConfig;
  env: Record<string, string | undefined>;
}

export interface S3StaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3ObjectStore implements ObjectStore {
  private readonly bucket: string;
  private readonly client: S3Client;
  private bucketReady: Promise<void> | undefined;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.config.bucket;
    const credentials = resolveS3Credentials(options.config, options.env);
    this.client = new S3Client({
      region: options.config.region,
      endpoint: options.config.endpoint,
      forcePathStyle: options.config.forcePathStyle,
      ...(credentials ? { credentials } : {})
    });
  }

  async putObject(input: ObjectStorePutInput): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType
      })
    );
  }

  async getObject(key: string): Promise<Uint8Array> {
    await this.ensureBucket();
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );
    const body = response.Body;
    if (!body) {
      throw new Error(`Object '${key}' had no response body`);
    }
    return body.transformToByteArray();
  }

  async deleteObject(key: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );
  }

  private ensureBucket(): Promise<void> {
    this.bucketReady ??= this.ensureBucketOnce();
    return this.bucketReady;
  }

  private async ensureBucketOnce(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({
          Bucket: this.bucket
        })
      );
      return;
    } catch {
      await this.client.send(
        new CreateBucketCommand({
          Bucket: this.bucket
        })
      );
    }
  }
}

export function resolveS3Credentials(
  config: DocumentObjectStorageConfig,
  env: Record<string, string | undefined>
): S3StaticCredentials | undefined {
  const accessKeyId = config.accessKeyIdEnvName
    ? env[config.accessKeyIdEnvName]
    : env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = config.secretAccessKeyEnvName
    ? env[config.secretAccessKeyEnvName]
    : env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey
    };
  }
  if (config.endpoint && isLocalS3MockEndpoint(config.endpoint)) {
    return {
      accessKeyId: "s3mock",
      secretAccessKey: "s3mock"
    };
  }
  return undefined;
}

function isLocalS3MockEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "s3mock";
  } catch {
    return false;
  }
}

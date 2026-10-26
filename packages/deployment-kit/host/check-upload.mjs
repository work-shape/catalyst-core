// The upload check of a deploy: one synthetic file goes through the API and has to come out
// processed. It runs inside the api container of the release and needs Node 22 and nothing
// else. lib/deploy-remote.sh hands it to node as the script of "-e".
//
// Who it is: the user "catalyst-deploy-check". It signs in the way an embedding backend signs
// its users in: the server credential the API already holds (CHAT_SERVER_CREDENTIAL) buys a
// session token for that user with the two conversation scopes, valid for the token's normal
// lifetime. No password and no API key is involved, and the credential never leaves the
// container. A service principal cannot do this: conversations belong to users.
//
// What it leaves: nothing a person can open. The conversation and its file are deleted at the
// end, whether the check passed or not. The user row and the audit events of the run stay.
//
// Input: the server credential on stdin, so that it is in no argument list, and
//   --release=NAME    the release, for the conversation title
//   --api=URL         default http://127.0.0.1:4100, plain HTTP inside the container
//   --wait=SECONDS    how long the file may take, default 600
//
// Output: lines that start with "upload-check:". After a failure one of them is
// "upload-check: attachment=<id>", which the deploy script uses to look up the job.
import { request } from "node:http";

/** @param {string} name */
const option = (name) =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const apiUrl = (option("api") ?? "http://127.0.0.1:4100").replace(/\/+$/, "");
const waitSeconds = Number(option("wait") ?? 600);
const release = option("release") ?? "unknown release";
const POLL_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const CHECK_USER = {
  externalUserId: "catalyst-deploy-check",
  displayLabel: "Deploy check (synthetic)"
};
const SCOPES = ["conversation:read", "conversation:write"];
const FILE_NAME = "deploy-check-synthetic.txt";

const say = (line) => console.log(`upload-check: ${line}`);

class CheckFailure extends Error {}

/** Sends one request and resolves with the status and the body text. */
function send(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const sent = request(
      `${apiUrl}${path}`,
      { method, headers, timeout: REQUEST_TIMEOUT_MS },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8")
          })
        );
        response.on("error", reject);
      }
    );
    sent.on("timeout", () =>
      sent.destroy(new Error(`no answer in ${REQUEST_TIMEOUT_MS / 1000} s`))
    );
    sent.on("error", reject);
    sent.end(body);
  });
}

/** One API call. Returns the parsed body; a refused call fails the check with the API's words. */
async function call(step, method, path, { token, credential, json, multipart } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (credential) headers["x-server-credential"] = credential;
  if (json) headers["content-type"] = "application/json";
  if (multipart) headers["content-type"] = `multipart/form-data; boundary=${multipart.boundary}`;
  const sentBody = json ? JSON.stringify(json) : multipart?.body;
  if (sentBody !== undefined) headers["content-length"] = Buffer.byteLength(sentBody);
  let answer;
  try {
    answer = await send(method, path, headers, sentBody);
  } catch (error) {
    throw new CheckFailure(
      `${step}: no answer from ${method} ${path} (${error.code ?? error.message})`
    );
  }
  let body;
  try {
    body = answer.text ? JSON.parse(answer.text) : undefined;
  } catch {
    body = undefined;
  }
  if (answer.status < 200 || answer.status >= 300) {
    const reason = body?.error?.message ?? answer.text.slice(0, 200);
    const failure = new CheckFailure(
      `${step}: ${method} ${path} answered ${answer.status} ${reason}`
    );
    failure.status = answer.status;
    throw failure;
  }
  return body;
}

/** The synthetic file as the body of a multipart upload. */
function syntheticFile() {
  const boundary = `catalyst-deploy-check-${Date.now()}`;
  const text = [
    "Synthetic file of the upload check that runs after a deploy of Workshape Catalyst.",
    `Release: ${release}`,
    `Written: ${new Date().toISOString()}`,
    "It holds no data of any person or customer and is deleted when the check ends."
  ].join("\n");
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${FILE_NAME}"`,
    "Content-Type: text/plain",
    "",
    text,
    `--${boundary}--`,
    ""
  ].join("\r\n");
  return { boundary, body };
}

async function signIn() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const credential = Buffer.concat(chunks).toString("utf8").trim();
  if (!credential) {
    throw new CheckFailure(
      "sign-in: CHAT_SERVER_CREDENTIAL is not set in this container; the check signs in with it"
    );
  }
  try {
    const issued = await call("sign-in", "POST", "/api/v1/instance/session-tokens", {
      credential,
      json: { ...CHECK_USER, scopes: SCOPES }
    });
    return issued.chatSessionToken;
  } catch (error) {
    if (error.status === 404) {
      throw new CheckFailure(
        "sign-in: this instance issues no session tokens (auth.sessionToken in its config); the check signs in through one"
      );
    }
    throw error;
  }
}

/** Waits until the file is processed. Throws with the state it was last seen in. */
async function waitUntilReady(token, conversationId, attachmentId) {
  const deadline = Date.now() + waitSeconds * 1000;
  let status = "queued";
  let lastProgress = 0;
  say(`waiting up to ${waitSeconds} s for document processing`);
  for (;;) {
    const page = await call(
      "wait",
      "GET",
      `/api/v1/conversations/${conversationId}/draft-attachments`,
      { token }
    );
    const attachment = page.items.find((item) => item.id === attachmentId);
    if (!attachment) {
      throw new CheckFailure("wait: the uploaded file is no longer among the draft attachments");
    }
    status = attachment.status;
    if (status === "ready") return;
    if (Date.now() - lastProgress >= 15_000) {
      say(`processing: state=${status}, ${Math.ceil((deadline - Date.now()) / 1000)} s remaining`);
      lastProgress = Date.now();
    }
    if (status !== "queued" && status !== "preprocessing") {
      const reason = attachment.error?.message ?? attachment.error?.code;
      throw new CheckFailure(
        `the file was not processed: its state is "${status}"${reason ? ` (${reason})` : ""}`
      );
    }
    if (Date.now() >= deadline) {
      throw new CheckFailure(
        `the file was not processed within ${waitSeconds} s: its state is still "${status}"`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Deletes what the check created. Returns what it could not delete. */
async function cleanUp(token, conversationId, attachmentId) {
  const left = [];
  if (attachmentId) {
    await call(
      "clean-up",
      "DELETE",
      `/api/v1/conversations/${conversationId}/draft-attachments/${attachmentId}`,
      { token }
    ).catch((error) => left.push(error.message));
  }
  await call("clean-up", "DELETE", `/api/v1/conversations/${conversationId}`, { token }).catch(
    (error) => left.push(error.message)
  );
  return left;
}

async function main() {
  if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
    throw new CheckFailure("--wait must be a positive number of seconds");
  }
  const started = Date.now();
  const token = await signIn();
  const title = `Deploy check ${release} (synthetic, safe to delete)`;
  const conversation = await call("conversation", "POST", "/api/v1/conversations", {
    token,
    json: { title }
  });
  let attachmentId;
  let failure;
  try {
    const uploaded = await call(
      "upload",
      "POST",
      `/api/v1/conversations/${conversation.id}/draft-attachments`,
      { token, multipart: syntheticFile() }
    );
    attachmentId = uploaded.attachment.id;
    await waitUntilReady(token, conversation.id, attachmentId);
  } catch (error) {
    failure = error;
  }
  const left = await cleanUp(token, conversation.id, attachmentId);
  if (failure) {
    // The job is looked up by the script that called this one, which can read the database.
    if (attachmentId) say(`attachment=${attachmentId}`);
    if (left.length > 0) say(`left behind: conversation ${conversation.id} "${title}"`);
    throw failure;
  }
  if (left.length > 0) {
    throw new CheckFailure(
      `the file was processed, but conversation ${conversation.id} "${title}" was not removed: ${left.join("; ")}`
    );
  }
  say(
    `a file uploaded as ${CHECK_USER.externalUserId} was processed in ${((Date.now() - started) / 1000).toFixed(1)} s; the conversation and the file are deleted`
  );
}

try {
  await main();
} catch (error) {
  say(`FAILED: ${error instanceof CheckFailure ? error.message : (error.stack ?? error)}`);
  process.exit(1);
}

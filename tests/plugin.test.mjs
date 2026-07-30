import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const script = join(repoRoot, "plugins", "aiforall-image-gen", "scripts", "generate.mjs");
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const transparentPixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+p5qgoAAAAABJRU5ErkJggg==";
const chromaFixture = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAkklEQVR4nO3aUQmAAAAD0fMwgjawfyIbaAfNICJy6PsfDPa7gYM0iZM4iZM4iZM4iZM4iZM4iZM4iZM4iRuvBtZ54knLtn9rAYmTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTuOH/C71M4iRO4iRO4iRO4iRO4iRO4iRO4ny7wF0n0qEFf5X4FJQAAAAASUVORK5CYII=";
const python = process.env.AIFORALL_PYTHON || "python";
const fullGreenPng = spawnSync(python, [
  "-c",
  "from PIL import Image; import io,base64; b=io.BytesIO(); Image.new('RGB',(64,64),(0,255,0)).save(b,format='PNG',compress_level=0); print(base64.b64encode(b.getvalue()).decode())",
], { encoding: "utf8" }).stdout.trim();

function runCli(args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd || repoRoot,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AIFORALL_API_KEY: "sk-aiforall-test-secret",
        AIFORALL_PYTHON: python,
        ...(options.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function withMockServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

test("AIFORALL_API_KEY is masked and marked as the environment source", async () => {
  const result = await runCli(["--get-config"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /AIFORALL_API_KEY/);
  assert.doesNotMatch(result.stdout, /sk-aiforall-test-secret/);
});

test("generation uses the aiforall Images route and current-project output directory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiforall-node-test-"));
  let captured = null;
  let cliResult = null;
  await withMockServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    captured = { url: request.url, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: onePixelPng }] }));
  }, async (apiRoot) => {
    cliResult = await runCli(["--prompt", "test image", "--size", "1280x720", "--quality", "high"], {
      cwd,
      env: { AIFORALL_IMAGE_GEN_TEST_API_ROOT: apiRoot },
    });
    assert.equal(cliResult.code, 0, `${cliResult.stdout}\n${cliResult.stderr}`);
  });
  assert.equal(captured.url, "/v1/images/generations");
  assert.equal(captured.auth, "Bearer sk-aiforall-test-secret");
  assert.equal(captured.body.model, "gpt-image-2");
  assert.equal(captured.body.size, "1280x720");
  assert.equal(captured.body.quality, "high");
  assert.match(cliResult.stdout, /Prompt: "test image"/);
  assert.doesNotMatch(cliResult.stdout, /Prompt: "undefined"/);
  const outputDir = join(cwd, "aiforall-image-gen");
  assert.ok(readdirSync(outputDir).some((name) => name.endsWith(".png")));
});

test("multipart edit sends ordered images, roles, and a validated mask", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiforall-edit-test-"));
  const imageOne = join(cwd, "one.png");
  const imageTwo = join(cwd, "two.png");
  const mask = join(cwd, "mask.png");
  const fixture = Buffer.from(onePixelPng, "base64");
  writeFileSync(imageOne, fixture);
  writeFileSync(imageTwo, fixture);
  writeFileSync(mask, fixture);
  let bodyText = "";
  await withMockServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodyText = Buffer.concat(chunks).toString("latin1");
    assert.equal(request.url, "/v1/images/edits");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: onePixelPng }] }));
  }, async (apiRoot) => {
    const result = await runCli([
      "--edit", "--image", imageOne, "--image-role", "identity",
      "--image", imageTwo, "--image-role", "style", "--mask", mask,
      "--prompt", "change only the background", "--size", "1024x1024", "--no-resize",
    ], { cwd, env: { AIFORALL_IMAGE_GEN_TEST_API_ROOT: apiRoot } });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  });
  assert.match(bodyText, /name="image\[\]"/);
  assert.match(bodyText, /name="mask"/);
  assert.match(bodyText, /Image 1: identity/);
  assert.match(bodyText, /Image 2: style/);
});

test("invalid gpt-image-2 sizes fail before a paid request", async () => {
  const result = await runCli(["--prompt", "invalid", "--size", "1279x720"]);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /multiples of 16/);
});

test("gpt-image-2 transparent mode performs local alpha extraction", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiforall-chroma-test-"));
  await withMockServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: chromaFixture }] }));
  }, async (apiRoot) => {
    const result = await runCli(["--prompt", "red square", "--transparent", "--no-resize"], {
      cwd,
      env: { AIFORALL_IMAGE_GEN_TEST_API_ROOT: apiRoot },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /alpha/);
    assert.match(result.stdout, /postprocessed/);
    assert.ok(!readdirSync(join(cwd, "aiforall-image-gen")).some((name) => name.includes(".source.")));
  });
});

test("failed adaptive chroma uses local rembg once without another API request", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiforall-rembg-fallback-test-"));
  const packageDir = join(cwd, "rembg");
  const marker = join(cwd, "rembg-model.txt");
  mkdirSync(packageDir);
  writeFileSync(join(packageDir, "__init__.py"), [
    "import os",
    "from PIL import Image, ImageDraw",
    "def new_session(name):",
    "    open(os.environ['AIFORALL_REMBG_MARKER'], 'w').write(name)",
    "    return name",
    "def remove(image, session=None):",
    "    result=image.convert('RGBA')",
    "    alpha=Image.new('L', result.size, 0)",
    "    ImageDraw.Draw(alpha).rectangle((16,16,47,47), fill=255)",
    "    result.putalpha(alpha)",
    "    return result",
    "",
  ].join("\n"));
  let requests = 0;
  await withMockServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: fullGreenPng }] }));
  }, async (apiRoot) => {
    const result = await runCli([
      "--prompt", "green fixture", "--transparent", "--no-resize",
      "--rembg-model", "u2net", "--keep-source",
    ], {
      cwd,
      env: {
        AIFORALL_IMAGE_GEN_TEST_API_ROOT: apiRoot,
        AIFORALL_REMBG_MARKER: marker,
        PYTHONPATH: `${cwd}${process.platform === "win32" ? ";" : ":"}${process.env.PYTHONPATH || ""}`,
      },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  });
  assert.equal(requests, 1);
  assert.equal(readFileSync(marker, "utf8"), "u2net");
  assert.ok(readdirSync(join(cwd, "aiforall-image-gen")).some((name) => name.includes(".source.")));
});

test("native transparency explicitly selects gpt-image-1.5 and background=transparent", async () => {
  let payload = null;
  await withMockServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: transparentPixelPng }] }));
  }, async (apiRoot) => {
    const cwd = mkdtempSync(join(tmpdir(), "aiforall-native-alpha-test-"));
    const result = await runCli(["--prompt", "cutout", "--native-transparent", "--size", "1024x1024", "--no-resize"], {
      cwd,
      env: { AIFORALL_IMAGE_GEN_TEST_API_ROOT: apiRoot, AIFORALL_IMAGE15_API_KEY: "sk-native-test" },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  });
  assert.equal(payload.model, "gpt-image-1.5");
  assert.equal(payload.background, "transparent");
  assert.equal(payload.output_format, "png");
});

test("native transparency rejects an opaque successful response without retrying", async () => {
  const authorizations = [];
  await withMockServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: onePixelPng }] }));
  }, async (apiRoot) => {
    const cwd = mkdtempSync(join(tmpdir(), "aiforall-native-opaque-test-"));
    const result = await runCli(["--prompt", "cutout", "--native-transparent", "--size", "1024x1024", "--no-resize"], {
      cwd,
      env: {
        AIFORALL_IMAGE_GEN_TEST_API_ROOT: apiRoot,
        AIFORALL_IMAGE15_API_KEYS: JSON.stringify(["sk-native-one", "sk-native-two"]),
      },
    });
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /\[NO-RETRY\].*opaque image/);
    assert.ok(readdirSync(join(cwd, "aiforall-image-gen")).some((name) => name.endsWith(".png")));
  });
  assert.deepEqual(authorizations, ["Bearer sk-native-one"]);
});

test("unsupported native transparency stops after one capability probe", async () => {
  const authorizations = [];
  await withMockServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Transparent background is not supported for this model." } }));
  }, async (apiRoot) => {
    const result = await runCli(["--prompt", "cutout", "--native-transparent", "--size", "1024x1024"], {
      env: {
        AIFORALL_IMAGE_GEN_TEST_API_ROOT: apiRoot,
        AIFORALL_IMAGE15_API_KEYS: JSON.stringify(["sk-native-one", "sk-native-two"]),
      },
    });
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /\[CAPABILITY-UNAVAILABLE\]/);
    assert.match(`${result.stdout}\n${result.stderr}`, /No fallback request was submitted/);
    assert.match(`${result.stdout}\n${result.stderr}`, /gpt-image-2 --transparent/);
  });
  assert.deepEqual(authorizations, ["Bearer sk-native-one"]);
  assert.ok(!authorizations.includes("Bearer sk-aiforall-test-secret"));
});

test("native transparency fails over only after an explicit key rejection", async () => {
  const authorizations = [];
  await withMockServer(async (request, response) => {
    const authorization = request.headers.authorization;
    authorizations.push(authorization);
    if (authorization === "Bearer sk-native-denied") {
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "Upstream access forbidden" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: transparentPixelPng }] }));
  }, async (apiRoot) => {
    const cwd = mkdtempSync(join(tmpdir(), "aiforall-native-failover-test-"));
    const result = await runCli(["--prompt", "cutout", "--native-transparent", "--size", "1024x1024", "--no-resize"], {
      cwd,
      env: {
        AIFORALL_IMAGE_GEN_TEST_API_ROOT: apiRoot,
        AIFORALL_IMAGE15_API_KEYS: JSON.stringify(["sk-native-denied", "sk-native-ok"]),
      },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  });
  assert.deepEqual(authorizations, ["Bearer sk-native-denied", "Bearer sk-native-ok"]);
});

test("native generic gateway failure is not retried across keys", async () => {
  let requests = 0;
  await withMockServer((_request, response) => {
    requests += 1;
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "Bad Gateway" }));
  }, async (apiRoot) => {
    const result = await runCli(["--prompt", "cutout", "--native-transparent", "--size", "1024x1024"], {
      env: {
        AIFORALL_IMAGE_GEN_TEST_API_ROOT: apiRoot,
        AIFORALL_IMAGE15_API_KEYS: JSON.stringify(["sk-native-one", "sk-native-two"]),
      },
    });
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /\[NO-RETRY\]/);
  });
  assert.equal(requests, 1);
});

test("exhausted native keys never fall back to the gpt-image-2 key", async () => {
  const authorizations = [];
  await withMockServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "forbidden for this group" }));
  }, async (apiRoot) => {
    const result = await runCli(["--prompt", "cutout", "--native-transparent", "--size", "1024x1024"], {
      env: {
        AIFORALL_IMAGE_GEN_TEST_API_ROOT: apiRoot,
        AIFORALL_IMAGE15_API_KEYS: JSON.stringify(["sk-native-one", "sk-native-two"]),
      },
    });
    assert.notEqual(result.code, 0);
  });
  assert.deepEqual(authorizations, ["Bearer sk-native-one", "Bearer sk-native-two"]);
  assert.ok(!authorizations.includes("Bearer sk-aiforall-test-secret"));
});

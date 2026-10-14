'use strict';

/**
 * Run the actual TypeScript API handler in-process against controlled NextAuth
 * and a controlled NextAuth adapter. NextRequest, NextResponse, Zod and
 * TypeScript come from the project's locked dependencies. An isolated loopback
 * HTTP bridge exercises response status/JSON without any user database or
 * third-party publishing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const ts = require('typescript');
const { z } = require('zod');
const { NextRequest, NextResponse } = require('next/server');

const SOURCE = process.env.PUBLISH_ROUTE_SOURCE
  || path.resolve(__dirname, '../../src/app/api/publish/route.ts');

function loadPost(session) {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: 'src/app/api/publish/route.ts',
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  const fatal = (output.diagnostics || []).filter(
    (diag) => diag.category === ts.DiagnosticCategory.Error
  );
  assert.equal(fatal.length, 0, 'route must transpile without TypeScript syntax errors');

  const module = { exports: {} };
  let networkCalls = 0;
  const fakeRequire = (id) => {
    if (id === 'next/server') return { NextRequest, NextResponse };
    if (id === 'next-auth') {
      return { getServerSession: async () => session };
    }
    if (id === '@/lib/auth') {
      return { authOptions: { testOnly: true } };
    }
    if (id === 'zod') return { z };
    throw new Error('Unexpected route dependency: ' + id);
  };
  const factory = vm.runInNewContext(
    '(function (require, module, exports) {\n' + output.outputText + '\n})',
    {
      Response,
      fetch() {
        networkCalls += 1;
        throw new Error('Outbound network is prohibited in API contract tests');
      },
      console: { log() {}, warn() {}, error() {} },
    },
    { filename: 'publish-route-transpiled.cjs', timeout: 1000 }
  );
  factory(fakeRequire, module, module.exports);
  assert.equal(typeof module.exports.POST, 'function', 'exported POST is required');
  return { post: module.exports.POST, networkCalls: () => networkCalls };
}

const authorized = { user: { email: 'pilot@example.invalid' } };
const settings = {
  id: 'fixed-test-preset',
  name: 'Contract fixture',
  platform: 'wechat',
  isDefault: false,
  headerContent: '',
  footerContent: '',
};

function payload(platform, platformConfig = undefined) {
  return {
    title: 'Contract test title',
    content: 'Contract test content',
    platform,
    settings: { ...settings, platform, platformConfig },
  };
}

async function invoke(post, body) {
  const request = new NextRequest('http://127.0.0.1:3000/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await post(request);
  assert.equal(response instanceof Response, true);
  return { status: response.status, data: await response.json() };
}

test('anonymous publishing remains unauthorized (401)', async () => {
  const { post, networkCalls } = loadPost(null);
  const result = await invoke(post, payload('wechat'));
  assert.equal(result.status, 401);
  assert.equal(result.data.success, false);
  assert.equal(networkCalls(), 0);
});

test('invalid title still receives validation failure (400)', async () => {
  const { post, networkCalls } = loadPost(authorized);
  const result = await invoke(post, { ...payload('wechat'), title: '' });
  assert.equal(result.status, 400);
  assert.equal(result.data.success, false);
  assert.equal(networkCalls(), 0);
});

test('unrecognized platform still receives validation failure (400)', async () => {
  const { post, networkCalls } = loadPost(authorized);
  const result = await invoke(post, payload('unknown-platform'));
  assert.equal(result.status, 400);
  assert.equal(result.data.success, false);
  assert.equal(networkCalls(), 0);
});

test('missing required settings still receives validation failure (400)', async () => {
  const { post } = loadPost(authorized);
  const invalid = payload('wechat');
  delete invalid.settings.isDefault;
  const result = await invoke(post, invalid);
  assert.equal(result.status, 400);
  assert.equal(result.data.success, false);
});

for (const platform of ['wechat', 'zhihu', 'juejin', 'zsxq']) {
  test('unimplemented ' + platform + ' never falsely reports published', async () => {
    const { post, networkCalls } = loadPost(authorized);
    const request = payload(platform, platform === 'zsxq'
      ? { groupIds: ['test-group-001'] }
      : undefined);
    const response = await invoke(post, request);
    assert.equal(response.status, 501, platform + ' must return HTTP 501');
    assert.equal(response.data.success, false, platform + ' must not claim success');
    assert.equal(typeof response.data.error, 'string');
    assert.ok(response.data.error.length > 0);
    assert.equal(Object.hasOwn(response.data, 'data'), false);
    assert.equal(networkCalls(), 0, 'no remote publishing requests');
  });
}

test('zsxq missing group configuration is still an unimplemented API operation', async () => {
  const { post, networkCalls } = loadPost(authorized);
  const response = await invoke(post, payload('zsxq', { groupIds: [] }));
  assert.equal(response.status, 501);
  assert.equal(response.data.success, false);
  assert.equal(networkCalls(), 0);
});

test('isolated loopback HTTP request reflects truthful publishing status', async () => {
  const { post, networkCalls } = loadPost(authorized);
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const request = new NextRequest('http://127.0.0.1/api/publish', {
        method: incoming.method,
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      });
      const result = await post(request);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(await result.text());
    } catch (error) {
      outgoing.writeHead(599, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ harnessError: String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload('wechat')),
    });
    assert.equal(response.status, 501);
    const data = await response.json();
    assert.equal(data.success, false);
    assert.ok(data.error);
    assert.equal(networkCalls(), 0);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});

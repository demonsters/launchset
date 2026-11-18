import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANIFEST_ACCEPT,
  parseChallenge,
  parseChallenges,
  parseImageName,
  verifyRegistry,
} from "../../src/verify/registry.ts";
import { makeCtx, tempDir, useServer } from "./helpers.ts";

const server = useServer();

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

/**
 * A token-auth registry (ghcr.io / Docker Hub style). `tags` are the existing tags per
 * repository. `requireCredentials` makes the token endpoint refuse anonymous requests.
 */
function tokenRegistry(opts: {
  host: string;
  realm: string;
  service: string;
  tags: Record<string, string[]>;
  requireCredentials?: string;
  manifestStatus?: number;
}) {
  // Recorded for assertions in the test body (an expect in a handler is only a 500).
  const seen = {
    tokenAuth: [] as (string | null)[],
    services: [] as (string | null)[],
    heads: [] as string[],
    accepts: [] as (string | null)[],
  };
  server.use(
    http.get(opts.realm, ({ request }) => {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization");
      seen.tokenAuth.push(auth);
      seen.services.push(url.searchParams.get("service"));
      if (opts.requireCredentials && auth !== opts.requireCredentials) {
        return HttpResponse.json(
          { errors: [{ code: "DENIED", message: "requested access to the resource is denied" }] },
          { status: 403 },
        );
      }
      const scope = url.searchParams.get("scope") ?? "";
      return HttpResponse.json({ token: `token-for:${scope}` });
    }),
    http.head(`https://${opts.host}/v2/*`, ({ request }) => {
      const url = new URL(request.url);
      seen.heads.push(url.pathname);
      const match = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url.pathname);
      const repository = match?.[1] ?? "";
      const tag = decodeURIComponent(match?.[2] ?? "");
      const scope = `repository:${repository}:pull`;
      if (request.headers.get("authorization") !== `Bearer token-for:${scope}`) {
        return new HttpResponse(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer realm="${opts.realm}",service="${opts.service}",scope="${scope}"`,
          },
        });
      }
      seen.accepts.push(request.headers.get("accept"));
      if (opts.manifestStatus) {
        return new HttpResponse(null, {
          status: opts.manifestStatus,
          headers: {
            "www-authenticate": `Bearer realm="${opts.realm}",error="insufficient_scope"`,
          },
        });
      }
      return new HttpResponse(null, { status: opts.tags[repository]?.includes(tag) ? 200 : 404 });
    }),
  );
  return seen;
}

const ghcr = (
  tags: Record<string, string[]>,
  extra: Partial<Parameters<typeof tokenRegistry>[0]> = {},
) =>
  tokenRegistry({
    host: "ghcr.io",
    realm: "https://ghcr.io/token",
    service: "ghcr.io",
    tags,
    ...extra,
  });

const dockerHub = (
  tags: Record<string, string[]>,
  extra: Partial<Parameters<typeof tokenRegistry>[0]> = {},
) =>
  tokenRegistry({
    host: "registry-1.docker.io",
    realm: "https://auth.docker.io/token",
    service: "registry.docker.io",
    tags,
    ...extra,
  });

describe("parseImageName", () => {
  it("parses hosts, Docker Hub names and ports", () => {
    expect(parseImageName("ghcr.io/org/app")).toMatchObject({
      host: "ghcr.io",
      repository: "org/app",
      baseUrl: "https://ghcr.io",
      authKey: "ghcr.io",
    });
    expect(parseImageName("org/app")).toMatchObject({
      host: "registry-1.docker.io",
      repository: "org/app",
      authKey: "https://index.docker.io/v1/",
      dockerHub: true,
    });
    expect(parseImageName("nginx")).toMatchObject({ repository: "library/nginx", dockerHub: true });
    expect(parseImageName("docker.io/nginx")).toMatchObject({ repository: "library/nginx" });
    expect(parseImageName("localhost:5000/app")).toMatchObject({
      host: "localhost:5000",
      repository: "app",
      baseUrl: "http://localhost:5000",
    });
    expect(parseImageName("registry.example.com:8443/team/sub/app")).toMatchObject({
      host: "registry.example.com:8443",
      repository: "team/sub/app",
      baseUrl: "https://registry.example.com:8443",
    });
  });

  it("rejects tags, digests and invalid names", () => {
    expect(() => parseImageName("ghcr.io/org/app:1.0.0")).toThrow(/contains a tag/);
    expect(() => parseImageName("localhost:5000/app:latest")).toThrow(/contains a tag/);
    expect(() => parseImageName("org/app@sha256:abc")).toThrow(/contains a digest/);
    expect(() => parseImageName("ghcr.io/Org/App")).toThrow(/isn't a valid image name/);
  });
});

describe("parseChallenge", () => {
  it("parses Bearer and Basic challenges", () => {
    expect(
      parseChallenge(
        'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:org/app:pull"',
      ),
    ).toEqual({
      scheme: "bearer",
      params: {
        realm: "https://ghcr.io/token",
        service: "ghcr.io",
        scope: "repository:org/app:pull",
      },
    });
    expect(parseChallenge('Basic realm="Registry Realm"')).toEqual({
      scheme: "basic",
      params: { realm: "Registry Realm" },
    });
    expect(parseChallenge(null)).toBeUndefined();
  });

  it("keeps the parameters of several challenges apart and prefers Bearer", () => {
    const header =
      'Basic realm="Registry Realm", Bearer realm="https://reg.example/token",service="reg"';
    expect(parseChallenges(header)).toEqual([
      { scheme: "basic", params: { realm: "Registry Realm" } },
      { scheme: "bearer", params: { realm: "https://reg.example/token", service: "reg" } },
    ]);
    expect(parseChallenge(header)).toEqual({
      scheme: "bearer",
      params: { realm: "https://reg.example/token", service: "reg" },
    });
    expect(
      parseChallenge(
        'Bearer realm="https://reg.example/token",service="reg", Basic realm="Registry Realm"',
      ),
    ).toEqual({ scheme: "bearer", params: { realm: "https://reg.example/token", service: "reg" } });
    expect(parseChallenge('Basic realm="a, b", charset="UTF-8"')).toEqual({
      scheme: "basic",
      params: { realm: "a, b", charset: "UTF-8" },
    });
  });
});

describe("verifyRegistry", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  it("ghcr.io: anonymous bearer token, tag exists", async () => {
    const seen = ghcr({ "org/app": ["1.5.0"] });
    const result = await verifyRegistry({ images: ["ghcr.io/org/app"], tag: "1.5.0" }, makeCtx());
    expect(result).toEqual({
      alreadyPublished: true,
      message: "ghcr.io/org/app:1.5.0 already exists",
    });
    expect(seen.tokenAuth).toEqual([null]);
    expect(seen.services).toEqual(["ghcr.io"]);
    expect(seen.accepts).toEqual([MANIFEST_ACCEPT]);
  });

  it("ghcr.io: 404 means not published", async () => {
    ghcr({ "org/app": ["1.4.0"] });
    const result = await verifyRegistry({ images: ["ghcr.io/org/app"], tag: "1.5.0" }, makeCtx());
    expect(result).toEqual({
      alreadyPublished: false,
      message: "ghcr.io/org/app:1.5.0 doesn't exist yet",
    });
  });

  it("uses the rendered v{version} verify tag in the URL", async () => {
    const seen = ghcr({ "org/app": ["v1.5.0"] });
    const result = await verifyRegistry({ images: ["ghcr.io/org/app"], tag: "v1.5.0" }, makeCtx());
    expect(result.alreadyPublished).toBe(true);
    expect(seen.heads).toContain("/v2/org/app/manifests/v1.5.0");
  });

  it("Docker Hub library image", async () => {
    const seen = dockerHub({ "library/app": ["1.5.0"] });
    const result = await verifyRegistry({ images: ["app"], tag: "1.5.0" }, makeCtx());
    expect(result.alreadyPublished).toBe(true);
    expect(seen.heads).toContain("/v2/library/app/manifests/1.5.0");
  });

  it("sends env credentials to the token endpoint", async () => {
    const auth = basic("bot", "s3cret");
    const seen = ghcr({ "org/private": ["1.5.0"] }, { requireCredentials: auth });
    const result = await verifyRegistry(
      { images: ["ghcr.io/org/private"], tag: "1.5.0" },
      makeCtx({ LAUNCHSET_REGISTRY_USERNAME: "bot", LAUNCHSET_REGISTRY_PASSWORD: "s3cret" }),
    );
    expect(result.alreadyPublished).toBe(true);
    expect(seen.tokenAuth).toEqual([auth]);
  });

  it("reads credentials from a temp Docker config file ($DOCKER_CONFIG)", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({
        auths: { "ghcr.io": { auth: Buffer.from("cfg-user:cfg-pass").toString("base64") } },
      }),
    );
    const auth = basic("cfg-user", "cfg-pass");
    const seen = ghcr({ "org/private": ["1.5.0"] }, { requireCredentials: auth });
    const result = await verifyRegistry(
      { images: ["ghcr.io/org/private"], tag: "1.5.0" },
      makeCtx({ DOCKER_CONFIG: dir }),
    );
    expect(result.alreadyPublished).toBe(true);
    expect(seen.tokenAuth).toEqual([auth]);
  });

  it("reads ~/.docker/config.json with a Docker Hub key and username/password", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    await mkdir(join(dir, ".docker"));
    await writeFile(
      join(dir, ".docker", "config.json"),
      JSON.stringify({
        auths: { "https://index.docker.io/v1/": { username: "hub", password: "pw" } },
      }),
    );
    const seen = dockerHub({ "org/app": [] });
    const result = await verifyRegistry(
      { images: ["org/app"], tag: "1.5.0" },
      makeCtx({ HOME: dir }),
    );
    expect(result.alreadyPublished).toBe(false);
    expect(seen.tokenAuth).toEqual([basic("hub", "pw")]);
  });

  it("403 on the token endpoint is an error with the GHCR hint and the credsStore note", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ auths: { "ghcr.io": {} }, credsStore: "desktop" }),
    );
    ghcr({ "org/private": ["1.5.0"] }, { requireCredentials: basic("x", "y") });
    const error = (await verifyRegistry(
      { images: ["ghcr.io/org/private"], tag: "1.5.0" },
      makeCtx({ DOCKER_CONFIG: dir }),
    ).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(
      /failed with HTTP 403 \(DENIED: requested access to the resource is denied\) anonymously/,
    );
    expect(error.message).toContain('credential helper "desktop"');
    expect(error.message).toContain("packages: read");
    expect(error.message).toContain("docker/login-action before the verify step");
  });

  it("403 on the manifest after auth is an error, never 'not published'", async () => {
    ghcr({ "org/app": [] }, { manifestStatus: 403 });
    await expect(
      verifyRegistry({ images: ["ghcr.io/org/app"], tag: "1.5.0" }, makeCtx()),
    ).rejects.toThrow(
      /HEAD https:\/\/ghcr.io\/v2\/org\/app\/manifests\/1.5.0\) failed with HTTP 403 \(insufficient_scope\) anonymously.*packages: read/,
    );
  });

  it("generic registry with basic auth", async () => {
    const auth = basic("u", "p");
    server.use(
      http.head(
        "https://registry.example.com/v2/team/app/manifests/:tag",
        ({ request, params }) => {
          if (request.headers.get("authorization") !== auth) {
            return new HttpResponse(null, {
              status: 401,
              headers: { "www-authenticate": 'Basic realm="Registry"' },
            });
          }
          return new HttpResponse(null, { status: params.tag === "1.5.0" ? 200 : 404 });
        },
      ),
    );
    const ctx = makeCtx({ LAUNCHSET_REGISTRY_USERNAME: "u", LAUNCHSET_REGISTRY_PASSWORD: "p" });
    expect(
      (await verifyRegistry({ images: ["registry.example.com/team/app"], tag: "1.5.0" }, ctx))
        .alreadyPublished,
    ).toBe(true);
    expect(
      (await verifyRegistry({ images: ["registry.example.com/team/app"], tag: "1.6.0" }, ctx))
        .alreadyPublished,
    ).toBe(false);
    await expect(
      verifyRegistry({ images: ["registry.example.com/team/app"], tag: "1.5.0" }, makeCtx()),
    ).rejects.toThrow(/HTTP 401 anonymously/);
  });

  it("env credentials go only to the first image's registry, never to the others", async () => {
    const auth = basic("gh-user", "ghp_secret");
    const gh = ghcr({ "org/app": ["1.5.0"] });
    const hub = dockerHub({ "org/app": ["1.5.0"] });
    const result = await verifyRegistry(
      { images: ["ghcr.io/org/app", "org/app"], tag: "1.5.0" },
      makeCtx({
        LAUNCHSET_REGISTRY_USERNAME: "gh-user",
        LAUNCHSET_REGISTRY_PASSWORD: "ghp_secret",
      }),
    );
    expect(result.alreadyPublished).toBe(true);
    expect(gh.tokenAuth).toEqual([auth]);
    expect(hub.tokenAuth).toEqual([null]);
  });

  it("LAUNCHSET_REGISTRY_HOST picks the registry of the env credentials (Docker Hub alias)", async () => {
    const auth = basic("hub-user", "hub-pass");
    const gh = ghcr({ "org/app": ["1.5.0"] });
    const hub = dockerHub({ "org/app": ["1.5.0"] });
    await verifyRegistry(
      { images: ["ghcr.io/org/app", "org/app"], tag: "1.5.0" },
      makeCtx({
        LAUNCHSET_REGISTRY_USERNAME: "hub-user",
        LAUNCHSET_REGISTRY_PASSWORD: "hub-pass",
        LAUNCHSET_REGISTRY_HOST: "https://index.docker.io/v1/",
      }),
    );
    // Docker Hub's token endpoint lives on auth.docker.io: that's where they go.
    expect(hub.tokenAuth).toEqual([auth]);
    expect(gh.tokenAuth).toEqual([null]);
  });

  it("other registries use their Docker config entry, and auth errors explain the binding", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({
        auths: { "docker.io": { auth: Buffer.from("cfg:pw").toString("base64") } },
      }),
    );
    ghcr({ "org/app": ["1.5.0"] });
    const hub = dockerHub({ "org/app": ["1.5.0"] });
    const env = {
      DOCKER_CONFIG: dir,
      LAUNCHSET_REGISTRY_USERNAME: "gh-user",
      LAUNCHSET_REGISTRY_PASSWORD: "ghp_secret",
    };
    await verifyRegistry({ images: ["ghcr.io/org/app", "org/app"], tag: "1.5.0" }, makeCtx(env));
    expect(hub.tokenAuth).toEqual([basic("cfg", "pw")]);

    ghcr({ "org/private": [] }, { requireCredentials: basic("x", "y") });
    const error = (await verifyRegistry(
      { images: ["docker.io/org/app", "ghcr.io/org/private"], tag: "1.5.0" },
      makeCtx({ LAUNCHSET_REGISTRY_USERNAME: "u", LAUNCHSET_REGISTRY_PASSWORD: "p" }),
    ).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("belong to docker.io and aren't sent to ghcr.io");
    expect(error.message).toContain("LAUNCHSET_REGISTRY_HOST");
  });

  it("answers the Bearer challenge when a registry offers Basic and Bearer", async () => {
    const tokenAuth: (string | null)[] = [];
    server.use(
      http.get("https://reg.example/token", ({ request }) => {
        tokenAuth.push(request.headers.get("authorization"));
        return HttpResponse.json({ token: "t" });
      }),
      http.head("https://reg.example/v2/team/app/manifests/:tag", ({ request }) =>
        request.headers.get("authorization") === "Bearer t"
          ? new HttpResponse(null, { status: 200 })
          : new HttpResponse(null, {
              status: 401,
              headers: {
                "www-authenticate":
                  'Basic realm="Registry Realm", Bearer realm="https://reg.example/token",service="reg"',
              },
            }),
      ),
    );
    const result = await verifyRegistry(
      { images: ["reg.example/team/app"], tag: "1.5.0" },
      makeCtx(),
    );
    expect(result.alreadyPublished).toBe(true);
    expect(tokenAuth).toEqual([null]);
  });

  it("multiple images: published only if the tag exists in every image", async () => {
    ghcr({ "org/app": ["1.5.0"] });
    dockerHub({ "org/app": ["1.5.0"] });
    const all = await verifyRegistry(
      { images: ["ghcr.io/org/app", "org/app"], tag: "1.5.0" },
      makeCtx(),
    );
    expect(all).toEqual({
      alreadyPublished: true,
      message: "ghcr.io/org/app:1.5.0, org/app:1.5.0 already exist",
    });
  });

  it("multiple images: some but not all is not published, and lists which", async () => {
    ghcr({ "org/app": ["1.5.0"] });
    dockerHub({ "org/app": [] });
    const some = await verifyRegistry(
      { images: ["ghcr.io/org/app", "org/app"], tag: "1.5.0" },
      makeCtx(),
    );
    expect(some).toEqual({
      alreadyPublished: false,
      message:
        "only some images have the tag: ghcr.io/org/app:1.5.0 exists, org/app:1.5.0 missing; not published",
    });
  });

  it("network errors are errors", async () => {
    server.use(http.head("https://ghcr.io/v2/*", () => HttpResponse.error()));
    await expect(
      verifyRegistry({ images: ["ghcr.io/org/app"], tag: "1.5.0" }, makeCtx()),
    ).rejects.toThrow(
      /Registry: HEAD https:\/\/ghcr.io\/v2\/org\/app\/manifests\/1.5.0 failed before a response arrived/,
    );
  });

  it("names the missing half of the env credentials", async () => {
    await expect(
      verifyRegistry(
        { images: ["ghcr.io/org/app"], tag: "1.5.0" },
        makeCtx({ LAUNCHSET_REGISTRY_USERNAME: "u" }),
      ),
    ).rejects.toThrow(/LAUNCHSET_REGISTRY_PASSWORD is not set, but LAUNCHSET_REGISTRY_USERNAME is/);
  });

  it("rejects an invalid verify tag", async () => {
    await expect(
      verifyRegistry({ images: ["ghcr.io/org/app"], tag: "1.5.0+build" }, makeCtx()),
    ).rejects.toThrow(/isn't a valid image tag/);
  });
});

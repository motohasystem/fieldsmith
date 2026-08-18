import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export const BASE_URL = "https://example.cybozu.com";
const PREVIEW = `${BASE_URL}/k/v1/preview`;
/** ゲストスペースのアプリは URL の前置きが変わる。 */
export const guestPreview = (spaceId: number | string) =>
  `${BASE_URL}/k/guest/${spaceId}/v1/preview`;

export interface RecordedCall {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

export interface KintoneMockOptions {
  /** 既存アプリを模す。update / pull のテストで使う。 */
  readonly existing?: {
    readonly settings?: Record<string, unknown>;
    readonly properties?: Record<string, Record<string, unknown>>;
    readonly views?: Record<string, Record<string, unknown>>;
  };
  /** getFormLayout が返すレイアウト。 */
  readonly layout?: unknown[];
  /** ゲストスペース ID。指定するとゲストスペース用の URL で待ち受ける。 */
  readonly guestSpaceId?: number | string;
  /** getDeployStatus が順に返すステータス。最後の値を以降も返し続ける。 */
  readonly deployStatuses?: readonly ("PROCESSING" | "SUCCESS" | "FAIL" | "CANCEL")[];
  /** 指定したパスで一度だけ返すエラー。 */
  readonly failOnce?: { readonly path: string; readonly status: number; readonly code?: string };
}

export interface KintoneMock {
  readonly calls: RecordedCall[];
  callsTo(path: string): RecordedCall[];
}

/**
 * kintone REST API のモック。
 * 実際に飛ぶ HTTP を観測することで、rest-api-client がどのエンドポイントを叩くかまで含めて検証する。
 */
export function setupKintoneMock(options: KintoneMockOptions = {}) {
  const calls: RecordedCall[] = [];
  const statuses = [...(options.deployStatuses ?? ["SUCCESS"])];
  let revision = 1;
  const failed = new Set<string>();

  const record = async (request: Request, path: string): Promise<Record<string, unknown>> => {
    const text = await request.text();
    const body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    calls.push({ path, method: request.method, body });
    return body;
  };

  const maybeFail = (path: string): Response | null => {
    const failure = options.failOnce;
    if (failure === undefined || failure.path !== path || failed.has(path)) return null;
    failed.add(path);
    return HttpResponse.json(
      { id: "test", code: failure.code ?? "GAIA_IL01", message: `${path} のモックエラー` },
      { status: failure.status },
    );
  };

  const prefix = options.guestSpaceId === undefined ? PREVIEW : guestPreview(options.guestSpaceId);

  const server = setupServer(
    http.post(`${prefix}/app.json`, async ({ request }) => {
      await record(request, "app");
      const failure = maybeFail("app");
      if (failure) return failure;
      return HttpResponse.json({ app: "42", revision: String(revision++) });
    }),
    http.post(`${prefix}/app/form/fields.json`, async ({ request }) => {
      await record(request, "fields");
      const failure = maybeFail("fields");
      if (failure) return failure;
      return HttpResponse.json({ revision: String(revision++) });
    }),
    // 既存アプリの読み取り。pull / update は動作テスト環境を見るので両方に応える。
    http.get(`${prefix}/app/settings.json`, () => {
      calls.push({ path: "getSettings", method: "GET", body: {} });
      return HttpResponse.json({
        name: "既存アプリ",
        description: "",
        theme: "WHITE",
        titleField: { selectionMode: "AUTO" },
        revision: "1",
        ...(options.existing?.settings ?? {}),
      });
    }),
    http.get(`${prefix}/app/form/fields.json`, () => {
      calls.push({ path: "getFields", method: "GET", body: {} });
      return HttpResponse.json({ properties: options.existing?.properties ?? {}, revision: "1" });
    }),
    http.get(`${prefix}/app/views.json`, () => {
      calls.push({ path: "getViews", method: "GET", body: {} });
      return HttpResponse.json({ views: options.existing?.views ?? {}, revision: "1" });
    }),
    http.get(`${BASE_URL}/k/v1/app/settings.json`, () => {
      calls.push({ path: "getSettings", method: "GET", body: {} });
      return HttpResponse.json({
        name: "既存アプリ",
        description: "",
        theme: "WHITE",
        titleField: { selectionMode: "AUTO" },
        revision: "1",
        ...(options.existing?.settings ?? {}),
      });
    }),
    http.get(`${BASE_URL}/k/v1/app/form/fields.json`, () => {
      calls.push({ path: "getFields", method: "GET", body: {} });
      return HttpResponse.json({ properties: options.existing?.properties ?? {}, revision: "1" });
    }),
    http.get(`${BASE_URL}/k/v1/app/form/layout.json`, () => {
      calls.push({ path: "getLiveLayout", method: "GET", body: {} });
      return HttpResponse.json({
        layout: Object.keys(options.existing?.properties ?? {}).map((code) => ({
          type: "ROW",
          fields: [{ code, type: options.existing!.properties![code]!["type"] }],
        })),
        revision: "1",
      });
    }),
    http.get(`${BASE_URL}/k/v1/app/views.json`, () => {
      calls.push({ path: "getViews", method: "GET", body: {} });
      return HttpResponse.json({ views: options.existing?.views ?? {}, revision: "1" });
    }),
    http.put(`${prefix}/app/form/fields.json`, async ({ request }) => {
      await record(request, "updateFields");
      const failure = maybeFail("updateFields");
      if (failure) return failure;
      return HttpResponse.json({ revision: String(revision++) });
    }),
    http.get(`${prefix}/app/form/layout.json`, ({ request }) => {
      calls.push({ path: "getLayout", method: "GET", body: {} });
      const failure = maybeFail("getLayout");
      if (failure) return failure;
      // フィールド追加直後の kintone は 1 行 1 フィールドで返す。
      const fallback = Object.entries(options.existing?.properties ?? {}).map(([code, p]) => ({
        type: "ROW",
        fields: [{ code, type: p["type"] }],
      }));
      return HttpResponse.json({ revision: String(revision), layout: options.layout ?? fallback });
    }),
    http.put(`${prefix}/app/form/layout.json`, async ({ request }) => {
      await record(request, "updateLayout");
      const failure = maybeFail("updateLayout");
      if (failure) return failure;
      return HttpResponse.json({ revision: String(revision++) });
    }),
    http.put(`${prefix}/app/settings.json`, async ({ request }) => {
      await record(request, "settings");
      const failure = maybeFail("settings");
      if (failure) return failure;
      return HttpResponse.json({ revision: String(revision++) });
    }),
    http.put(`${prefix}/app/views.json`, async ({ request }) => {
      await record(request, "views");
      const failure = maybeFail("views");
      if (failure) return failure;
      return HttpResponse.json({ revision: String(revision++), views: {} });
    }),
    http.post(options.guestSpaceId === undefined ? `${BASE_URL}/k/v1/file.json` : `${BASE_URL}/k/guest/${options.guestSpaceId}/v1/file.json`, async ({ request }) => {
      // multipart なので本文は読まず、呼ばれたことと大きさだけ記録する。
      const body = await request.arrayBuffer();
      calls.push({ path: "file", method: "POST", body: { bytes: body.byteLength } });
      const failure = maybeFail("file");
      if (failure) return failure;
      return HttpResponse.json({ fileKey: "test-file-key" });
    }),
    http.post(`${prefix}/app/deploy.json`, async ({ request }) => {
      const body = await record(request, "deploy");
      const failure = maybeFail("deploy");
      if (failure) return failure;
      return HttpResponse.json(body["revert"] === true ? {} : {});
    }),
    // OAuth では使えない API。呼ばれてしまったことを検知するために置いている。
    http.get(`${BASE_URL}/k/v1/space.json`, () => {
      calls.push({ path: "spaceInfo", method: "GET", body: {} });
      return HttpResponse.json({ defaultThread: "999" });
    }),
    http.get(`${prefix}/app/deploy.json`, ({ request }) => {
      calls.push({ path: "deployStatus", method: "GET", body: {} });
      const failure = maybeFail("deployStatus");
      if (failure) return failure;
      const url = new URL(request.url);
      const app = url.searchParams.get("apps[0]") ?? "42";
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return HttpResponse.json({ apps: [{ app, status }] });
    }),
  );

  const mock: KintoneMock = {
    calls,
    callsTo: (path) => calls.filter((call) => call.path === path),
  };

  return { server, mock };
}

export const noSleep = async (): Promise<void> => {};

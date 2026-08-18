import { describe, expect, it } from "vitest";
import {
  AppSpecValidationError,
  fieldGroups,
  parseAppSpec,
  resolveFieldCode,
} from "../src/spec/appSpec.js";
import { deriveFieldCode, validateFieldCode } from "../src/spec/fieldSpec.js";
import { toFieldProperties, toKintonePayloads, toOptions, toViews } from "../src/spec/toKintone.js";

const minimalSpec = {
  name: "案件管理",
  fields: [{ type: "SINGLE_LINE_TEXT", label: "案件名", required: true }],
};

function expectIssues(input: unknown): { path: string; message: string }[] {
  try {
    parseAppSpec(input);
  } catch (error) {
    if (error instanceof AppSpecValidationError) return [...error.issues];
    throw error;
  }
  throw new Error("検証が通ってしまいました");
}

describe("フィールドコード", () => {
  it("label から導出する", () => {
    expect(deriveFieldCode("案件名")).toBe("案件名");
    // 禁止文字は `_` に置換したうえで連続・前後の `_` を畳む。
    expect(deriveFieldCode("受注確度 (%)")).toBe("受注確度");
    expect(deriveFieldCode("金額 合計")).toBe("金額_合計");
    expect(deriveFieldCode("2024年度")).toBe("f_2024年度");
  });

  it("先頭の数字・禁止文字・予約語を弾く", () => {
    expect(validateFieldCode("1st")?.reason).toMatch(/先頭に数字/);
    expect(validateFieldCode("a b")?.reason).toMatch(/使用できない文字/);
    expect(validateFieldCode("ステータス")?.reason).toMatch(/予約語/);
    expect(validateFieldCode("案件名")).toBeNull();
  });

  it("code 未指定なら label から解決する", () => {
    const spec = parseAppSpec(minimalSpec);
    expect(resolveFieldCode(spec.fields[0]!)).toBe("案件名");
  });

  it("重複したフィールドコードを弾く", () => {
    const issues = expectIssues({
      name: "重複",
      fields: [
        { type: "SINGLE_LINE_TEXT", label: "名前", code: "名前" },
        { type: "NUMBER", label: "別ラベル", code: "名前" },
      ],
    });
    expect(issues.some((i) => /重複/.test(i.message))).toBe(true);
  });
});

describe("追加できないフィールド型", () => {
  it.each([
    ["STATUS", /プロセス管理/],
    ["CATEGORY", /カテゴリー/],
    ["RECORD_NUMBER", /自動生成/],
    ["SUBTABLE", /未対応/],
  ])("%s は API を呼ぶ前に弾く", (type, pattern) => {
    const issues = expectIssues({ name: "アプリ", fields: [{ type, label: "x" }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(pattern);
  });
});

describe("選択肢フィールド", () => {
  it("options を kintone の {label, index} 形式に変換する", () => {
    expect(toOptions(["高", "中", "低"])).toEqual({
      高: { label: "高", index: "0" },
      中: { label: "中", index: "1" },
      低: { label: "低", index: "2" },
    });
  });

  it("options に無い defaultValue を弾く", () => {
    const issues = expectIssues({
      name: "アプリ",
      fields: [
        { type: "DROP_DOWN", label: "確度", options: ["高", "低"], defaultValue: "中" },
      ],
    });
    expect(issues[0]!.message).toMatch(/options に含まれていません/);
  });

  it("重複した選択肢を弾く", () => {
    const issues = expectIssues({
      name: "アプリ",
      fields: [{ type: "DROP_DOWN", label: "確度", options: ["高", "高"] }],
    });
    expect(issues[0]!.message).toMatch(/重複/);
  });

  it("複数選択系の defaultValue は配列に正規化する", () => {
    const spec = parseAppSpec({
      name: "アプリ",
      fields: [
        { type: "CHECK_BOX", label: "タグ", options: ["A", "B"], defaultValue: "A" },
        { type: "DROP_DOWN", label: "確度", options: ["高", "低"], defaultValue: "高" },
      ],
    });
    const properties = toFieldProperties(spec.fields);
    expect(properties["タグ"]!["defaultValue"]).toEqual(["A"]);
    expect(properties["確度"]!["defaultValue"]).toBe("高");
  });

  it("単一選択に配列の defaultValue を渡すと弾く", () => {
    const issues = expectIssues({
      name: "アプリ",
      fields: [
        { type: "RADIO_BUTTON", label: "確度", options: ["高"], defaultValue: ["高"] },
      ],
    });
    expect(issues[0]!.message).toMatch(/文字列で指定/);
  });
});

describe("数値の変換", () => {
  it("kintone が文字列で受け取る項目を文字列化する", () => {
    const spec = parseAppSpec({
      name: "アプリ",
      fields: [
        { type: "NUMBER", label: "金額", minValue: 0, maxValue: 1000000, digit: true, unit: "円", unitPosition: "AFTER" },
      ],
    });
    const property = toFieldProperties(spec.fields)["金額"]!;
    expect(property["minValue"]).toBe("0");
    expect(property["maxValue"]).toBe("1000000");
    expect(property["digit"]).toBe(true);
    expect(property["unitPosition"]).toBe("AFTER");
  });
});

describe("上限値", () => {
  it("アプリ名 64 文字超を弾く", () => {
    const issues = expectIssues({ ...minimalSpec, name: "あ".repeat(65) });
    expect(issues.some((i) => i.path === "name")).toBe(true);
  });

  it("説明 10,000 文字超を弾く", () => {
    const issues = expectIssues({ ...minimalSpec, description: "あ".repeat(10001) });
    expect(issues.some((i) => i.path === "description")).toBe(true);
  });

  it("フィールド 0 件を弾く", () => {
    const issues = expectIssues({ name: "アプリ", fields: [] });
    expect(issues[0]!.message).toMatch(/1 つ以上/);
  });
});

describe("一覧", () => {
  it("存在しないフィールドコードの参照を弾く", () => {
    const issues = expectIssues({
      ...minimalSpec,
      views: [{ name: "一覧", type: "LIST", fields: ["存在しない"] }],
    });
    expect(issues[0]!.message).toMatch(/fields に存在しません/);
  });

  it("組み込みフィールドは一覧に指定できる", () => {
    const spec = parseAppSpec({
      ...minimalSpec,
      views: [{ name: "一覧", type: "LIST", fields: ["案件名", "レコード番号", "更新日時"] }],
    });
    expect(spec.views).toHaveLength(1);
  });

  it("CALENDAR に date が無ければ弾く", () => {
    const issues = expectIssues({
      ...minimalSpec,
      views: [{ name: "カレンダー", type: "CALENDAR" }],
    });
    expect(issues[0]!.message).toMatch(/date が必要/);
  });

  it("index を配列順で振る", () => {
    const views = toViews([
      { name: "B", type: "LIST", fields: ["x"] },
      { name: "A", type: "LIST", fields: ["y"] },
    ]);
    expect(views["B"]!["index"]).toBe("0");
    expect(views["A"]!["index"]).toBe("1");
  });

  it("重複した一覧名を弾く", () => {
    const issues = expectIssues({
      ...minimalSpec,
      views: [
        { name: "一覧", type: "LIST" },
        { name: "一覧", type: "LIST" },
      ],
    });
    expect(issues.some((i) => /一覧名/.test(i.message))).toBe(true);
  });
});

describe("一般設定", () => {
  it("titleFieldCode を titleField に変換する", () => {
    const spec = parseAppSpec({
      ...minimalSpec,
      description: "説明",
      theme: "BLUE",
      settings: { titleFieldCode: "案件名", enableComments: true },
    });
    const { settings } = toKintonePayloads(spec);
    expect(settings).toEqual({
      description: "説明",
      theme: "BLUE",
      titleField: { selectionMode: "MANUAL", code: "案件名" },
      enableComments: true,
    });
  });

  it("設定が何も無ければ null を返す (API を呼ばない判断に使う)", () => {
    expect(toKintonePayloads(parseAppSpec(minimalSpec)).settings).toBeNull();
  });

  it("存在しない titleFieldCode を弾く", () => {
    const issues = expectIssues({ ...minimalSpec, settings: { titleFieldCode: "無い" } });
    expect(issues[0]!.message).toMatch(/fields に存在しません/);
  });
});

describe("意味のまとまり (group)", () => {
  it("同じ group のフィールドが離れていたら弾く", () => {
    // 離れていると横に並ばず、散らばった行になる。気付きにくいので事前に指摘する。
    const issues = expectIssues({
      name: "アプリ",
      fields: [
        { type: "SINGLE_LINE_TEXT", label: "出版社", group: "書誌情報" },
        { type: "SINGLE_LINE_TEXT", label: "貸出先", group: "貸出" },
        { type: "SINGLE_LINE_TEXT", label: "ISBN", group: "書誌情報" },
      ],
    });
    expect(issues[0]!.message).toMatch(/離れて書かれています/);
    expect(issues[0]!.path).toBe("fields.2.group");
  });

  it("続けて並んでいれば通る", () => {
    const spec = parseAppSpec({
      name: "アプリ",
      fields: [
        { type: "SINGLE_LINE_TEXT", label: "出版社", group: "書誌情報" },
        { type: "SINGLE_LINE_TEXT", label: "ISBN", group: "書誌情報" },
        { type: "SINGLE_LINE_TEXT", label: "貸出先", group: "貸出" },
      ],
    });
    expect(fieldGroups(spec)).toEqual({ 出版社: "書誌情報", ISBN: "書誌情報", 貸出先: "貸出" });
  });

  it("group を付けなくてもよい", () => {
    const spec = parseAppSpec(minimalSpec);
    expect(fieldGroups(spec)).toEqual({});
  });
});

describe("未知のキー", () => {
  it("typo を見逃さない", () => {
    const issues = expectIssues({ ...minimalSpec, fieldz: [] });
    expect(issues.length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { CsvError, parseCsv, toCsvTable } from "../src/csv.js";
import { checkRecords } from "../src/spec/checkRecords.js";
import { parseAppSpec } from "../src/spec/appSpec.js";

/**
 * 投入前の突き合わせ。
 *
 * kintone のレコード追加は 100 件のかたまり単位で失敗するので、
 * 1 件の違反が 100 件の取りこぼしになる。投入する前に見つけることに価値がある。
 */

describe("CSV の読み取り", () => {
  it("引用符の中の改行を 1 つのセルとして扱う", () => {
    // チェックボックスの複数値はセル内改行で来る。行単位で切ると壊れる。
    expect(parseCsv('a,b\n"急ぎ\n要確認",x\n')).toEqual([
      ["a", "b"],
      ["急ぎ\n要確認", "x"],
    ]);
  });

  it('"" を引用符そのものとして読む', () => {
    expect(parseCsv('a\n"say ""hi"""\n')).toEqual([["a"], ['say "hi"']]);
  });

  it("CRLF と BOM を落とす", () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n')).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("引用符が閉じていなければ弾く", () => {
    expect(() => parseCsv('a\n"open\n')).toThrow(CsvError);
  });

  it("見出しが重複していたら弾く", () => {
    expect(() => toCsvTable(parseCsv("a,a\n1,2\n"))).toThrow(/同じ列が 2 つ以上/);
  });
});

describe("レコードへの組み直し", () => {
  it("* が無ければ 1 行 1 件", () => {
    const table = toCsvTable(parseCsv("件名\nA\nB\n"));
    expect(table.records.map((r) => r.values["件名"])).toEqual(["A", "B"]);
  });

  it("* があれば、印から次の印までが 1 件", () => {
    // テーブルの外の値は先頭行にだけ書かれる (cli-kintone の形式)。
    const table = toCsvTable(parseCsv("*,件名,品名\n*,A,杉板\n,,檜角材\n*,B,合板\n"));

    expect(table.records).toHaveLength(2);
    expect(table.records[0]!.values["件名"]).toBe("A");
    expect(table.records[0]!.rows.map((row) => row.values["品名"])).toEqual(["杉板", "檜角材"]);
    expect(table.records[1]!.rows).toHaveLength(1);
  });

  it("行番号は見出しを 1 行目として数える", () => {
    const table = toCsvTable(parseCsv("件名\nA\nB\n"));
    expect(table.records.map((r) => r.line)).toEqual([2, 3]);
  });
});

describe("spec との突き合わせ", () => {
  const spec = parseAppSpec({
    name: "取引先",
    fields: [
      { type: "SINGLE_LINE_TEXT", label: "コード", required: true, unique: true },
      { type: "NUMBER", label: "締日", minValue: 0, maxValue: 31 },
      { type: "SINGLE_LINE_TEXT", label: "郵便番号", maxLength: 8 },
      { type: "DROP_DOWN", label: "種別", options: ["仕入先", "得意先"] },
      { type: "DATE", label: "登録日" },
    ],
  });
  const check = (csv: string) => checkRecords(spec, toCsvTable(parseCsv(csv)));
  const kinds = (csv: string) => check(csv).issues.map((issue) => `${issue.field}:${issue.kind}`);

  const header = "コード,締日,郵便番号,種別,登録日\n";

  it("違反が無ければ何も出さない", () => {
    expect(check(`${header}A001,20,305-0056,仕入先,2026-01-05\n`).issues).toEqual([]);
  });

  it("上限を超える値を、件数と例つきで拾う", () => {
    const result = check(`${header}A001,90,,,\nA002,90,,,\nA003,20,,,\n`);
    const issue = result.issues.find((entry) => entry.kind === "range")!;

    expect(issue.count).toBe(2);
    expect(issue.message).toMatch(/maxValue 31 を超える/);
    expect(issue.samples[0]).toEqual({ line: 2, id: "コード=A001", value: "90" });
  });

  it("必須・重複・選択肢・文字数・日付を見る", () => {
    expect(kinds(`${header},20,,,\n`)).toContain("コード:required");
    expect(kinds(`${header}A001,20,,,\nA001,20,,,\n`)).toContain("コード:duplicate");
    expect(kinds(`${header}A001,20,,商社,\n`)).toContain("種別:option");
    expect(kinds(`${header}A001,20,x305-0056,,\n`)).toContain("郵便番号:length");
    expect(kinds(`${header}A001,20,,,不明\n`)).toContain("登録日:date");
    expect(kinds(`${header}A001,abc,,,\n`)).toContain("締日:number");
  });

  it("空の値は制約を見ない (必須のときだけ拾う)", () => {
    // 空欄は「入れない」であって「不正な値」ではない。
    expect(kinds(`${header}A001,,,,\n`)).toEqual([]);
  });

  it("列の過不足は警告として伝える", () => {
    const result = check("コード,与信限度額\nA001,100\n");
    const found = result.issues.map((issue) => `${issue.field}:${issue.kind}`);

    expect(found).toContain("締日:missingColumn");
    expect(found).toContain("与信限度額:extraColumn");
    expect(result.errors).toBe(0);
  });

  it("自動で付くフィールドは、無視される旨を伝える", () => {
    const result = check("コード,レコード番号\nA001,1\n");
    expect(result.issues.find((issue) => issue.field === "レコード番号")!.kind).toBe(
      "ignoredColumn",
    );
  });
});

describe("テーブルのある CSV", () => {
  const spec = parseAppSpec({
    name: "受注",
    fields: [
      { type: "SINGLE_LINE_TEXT", label: "件名", required: true },
      { type: "CHECK_BOX", label: "タグ", options: ["急ぎ", "要確認"] },
      { type: "SINGLE_LINE_TEXT", label: "品名", required: true, table: "明細" },
      { type: "NUMBER", label: "数量", minValue: 1, table: "明細" },
    ],
  });
  const check = (csv: string) => checkRecords(spec, toCsvTable(parseCsv(csv)));

  it("テーブルの列はレコード内の全行を見る", () => {
    const result = check('*,件名,タグ,品名,数量\n*,A,急ぎ,杉板,10\n,,,檜角材,0\n');
    const issue = result.issues.find((entry) => entry.kind === "range")!;

    expect(issue.field).toBe("数量");
    expect(issue.samples[0]!.line).toBe(3);
    // 続きの行でも、どのレコードのものか分かるようにする。
    expect(issue.samples[0]!.id).toBe("件名=A");
  });

  it("テーブルの外の列は先頭行だけを見る", () => {
    // 続きの行が空なのは正常。必須違反として数えてはいけない。
    expect(check('*,件名,タグ,品名,数量\n*,A,急ぎ,杉板,10\n,,,檜角材,2\n').issues).toEqual([]);
  });

  it("複数値はセル内改行で分けてから選択肢と突き合わせる", () => {
    expect(check('*,件名,タグ,品名,数量\n*,A,"急ぎ\n要確認",杉板,1\n').issues).toEqual([]);
    expect(
      check('*,件名,タグ,品名,数量\n*,A,"急ぎ\n至急",杉板,1\n').issues.map((i) => i.kind),
    ).toEqual(["option"]);
  });
});

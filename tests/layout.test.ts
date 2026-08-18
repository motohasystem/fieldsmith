import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PER_ROW,
  describeRows,
  familyOf,
  groupIntoRows,
  regroupLayout,
  type LayoutField,
  type LayoutRow,
} from "../src/spec/layout.js";

/** `code:TYPE` の並びから LayoutField[] を作る。 */
function fields(...spec: string[]): LayoutField[] {
  return spec.map((entry) => {
    const [code, type] = entry.split(":");
    return { code: code!, type: type! };
  });
}

/** 行ごとのフィールドコードにして比較しやすくする。 */
function codes(rows: LayoutField[][]): string[][] {
  return rows.map((row) => row.map((field) => field.code));
}

describe("フィールドの系統", () => {
  it.each([
    ["SINGLE_LINE_TEXT", "LINK"],
    ["NUMBER", "CALC"],
    ["DROP_DOWN", "RADIO_BUTTON"],
    ["DATE", "DATETIME"],
    ["USER_SELECT", "GROUP_SELECT"],
  ])("%s と %s は同じ系統", (a, b) => {
    expect(familyOf(a)).toBe(familyOf(b));
    expect(familyOf(a)).not.toBeNull();
  });

  it("系統が違えば混ざらない", () => {
    expect(familyOf("SINGLE_LINE_TEXT")).not.toBe(familyOf("NUMBER"));
    expect(familyOf("DROP_DOWN")).not.toBe(familyOf("DATE"));
  });

  it.each(["MULTI_LINE_TEXT", "RICH_TEXT", "FILE", "SUBTABLE"])(
    "%s は単独行 (幅や高さを取るため)",
    (type) => {
      expect(familyOf(type)).toBeNull();
    },
  );
});

describe("行へのまとめ方", () => {
  it("同じ系統を最大 3 つまで横に並べる", () => {
    const rows = groupIntoRows(fields("a:SINGLE_LINE_TEXT", "b:SINGLE_LINE_TEXT", "c:SINGLE_LINE_TEXT"));
    expect(codes(rows)).toEqual([["a", "b", "c"]]);
  });

  it("上限を超えたら次の行に送る", () => {
    const rows = groupIntoRows(
      fields(
        "a:SINGLE_LINE_TEXT",
        "b:SINGLE_LINE_TEXT",
        "c:SINGLE_LINE_TEXT",
        "d:SINGLE_LINE_TEXT",
      ),
    );
    expect(codes(rows)).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("系統が変わったところで行を切る", () => {
    const rows = groupIntoRows(
      fields("a:SINGLE_LINE_TEXT", "b:NUMBER", "c:DROP_DOWN", "d:DROP_DOWN"),
    );
    expect(codes(rows)).toEqual([["a"], ["b"], ["c", "d"]]);
  });

  it("並び順を変えない (AppSpec に書いた意図を保つ)", () => {
    const input = fields("a:SINGLE_LINE_TEXT", "b:NUMBER", "c:SINGLE_LINE_TEXT");
    const flattened = groupIntoRows(input).flat().map((f) => f.code);
    // 同じ系統でも離れていれば寄せ集めない。
    expect(flattened).toEqual(["a", "b", "c"]);
    expect(codes(groupIntoRows(input))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("単独行の型は前後と混ざらない", () => {
    const rows = groupIntoRows(
      fields("a:SINGLE_LINE_TEXT", "memo:MULTI_LINE_TEXT", "b:SINGLE_LINE_TEXT"),
    );
    expect(codes(rows)).toEqual([["a"], ["memo"], ["b"]]);
  });

  it("maxPerRow を変えられる", () => {
    const input = fields("a:SINGLE_LINE_TEXT", "b:SINGLE_LINE_TEXT", "c:SINGLE_LINE_TEXT");
    expect(codes(groupIntoRows(input, { maxPerRow: 2 }))).toEqual([["a", "b"], ["c"]]);
    expect(codes(groupIntoRows(input, { maxPerRow: 1 }))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("0 以下を指定されても 1 として扱う (行が消えない)", () => {
    const rows = groupIntoRows(fields("a:SINGLE_LINE_TEXT", "b:SINGLE_LINE_TEXT"), {
      maxPerRow: 0,
    });
    expect(codes(rows)).toEqual([["a"], ["b"]]);
  });

  it("空なら空", () => {
    expect(groupIntoRows([])).toEqual([]);
  });

  it("既定の上限は 3", () => {
    expect(DEFAULT_MAX_PER_ROW).toBe(3);
  });

  it("すべてのフィールドが必ずどこかの行に入る", () => {
    const input = fields(
      "a:SINGLE_LINE_TEXT",
      "b:MULTI_LINE_TEXT",
      "c:DROP_DOWN",
      "d:DROP_DOWN",
      "e:DROP_DOWN",
      "f:DROP_DOWN",
      "g:FILE",
    );
    // レイアウト API は「フォーム上のすべてのフィールド」の指定を求めるので、
    // 1 つでも落ちると失敗する。
    expect(groupIntoRows(input).flat()).toHaveLength(input.length);
  });
});

describe("意味のまとまり (group) でのまとめ方", () => {
  it("型が違っても同じ group なら横に並べる", () => {
    const rows = groupIntoRows(
      fields("publisher:SINGLE_LINE_TEXT", "publishedYear:NUMBER", "isbn:SINGLE_LINE_TEXT"),
      { groups: { publisher: "書誌情報", publishedYear: "書誌情報", isbn: "書誌情報" } },
    );
    // 型の系統ではテキスト / 数値 / テキストに割れるが、意味では 1 行にまとまる。
    expect(codes(rows)).toEqual([["publisher", "publishedYear", "isbn"]]);
  });

  it("同じ型でも group が違えば分かれる", () => {
    const rows = groupIntoRows(fields("a:SINGLE_LINE_TEXT", "b:SINGLE_LINE_TEXT"), {
      groups: { a: "書誌情報", b: "貸出" },
    });
    expect(codes(rows)).toEqual([["a"], ["b"]]);
  });

  it("group があっても上限は超えない", () => {
    const rows = groupIntoRows(
      fields("a:SINGLE_LINE_TEXT", "b:SINGLE_LINE_TEXT", "c:SINGLE_LINE_TEXT", "d:SINGLE_LINE_TEXT"),
      { groups: { a: "x", b: "x", c: "x", d: "x" }, maxPerRow: 3 },
    );
    expect(codes(rows)).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("group が無いフィールドは型の系統で代用する", () => {
    const rows = groupIntoRows(
      fields("a:SINGLE_LINE_TEXT", "b:SINGLE_LINE_TEXT", "c:NUMBER"),
      { groups: { c: "数量" } },
    );
    expect(codes(rows)).toEqual([["a", "b"], ["c"]]);
  });

  it("幅を取る型は group があっても単独行", () => {
    // 見た目の制約は意味とは別の話。
    const rows = groupIntoRows(fields("a:SINGLE_LINE_TEXT", "memo:MULTI_LINE_TEXT"), {
      groups: { a: "備考", memo: "備考" },
    });
    expect(codes(rows)).toEqual([["a"], ["memo"]]);
  });

  it("空文字の group は指定なしとして扱う", () => {
    const rows = groupIntoRows(fields("a:SINGLE_LINE_TEXT", "b:SINGLE_LINE_TEXT"), {
      groups: { a: "", b: "" },
    });
    expect(codes(rows)).toEqual([["a", "b"]]);
  });

  it("group 名が型の系統名と衝突しても混ざらない", () => {
    // group は接頭辞を付けて区別している。
    const rows = groupIntoRows(fields("a:SINGLE_LINE_TEXT", "b:SINGLE_LINE_TEXT"), {
      groups: { b: "テキスト" },
    });
    expect(codes(rows)).toEqual([["a"], ["b"]]);
  });
});

describe("既存レイアウトの並べ替え", () => {
  const row = (...codesIn: string[]): LayoutRow => ({
    type: "ROW",
    fields: codesIn.map((c) => ({ code: c, type: "SINGLE_LINE_TEXT" })),
  });

  it("1 行 1 フィールドの状態をまとめ直す", () => {
    const result = regroupLayout([row("a"), row("b"), row("c"), row("d")]);
    expect(result).toEqual([
      { type: "ROW", fields: [expect.objectContaining({ code: "a" }), expect.objectContaining({ code: "b" }), expect.objectContaining({ code: "c" })] },
      { type: "ROW", fields: [expect.objectContaining({ code: "d" })] },
    ]);
  });

  it("SUBTABLE と GROUP はそのまま残す", () => {
    const subtable: LayoutRow = { type: "SUBTABLE", code: "table", fields: [] };
    const group: LayoutRow = { type: "GROUP", code: "grp", layout: [] };

    const result = regroupLayout([row("a"), subtable, row("b"), row("c"), group]);

    expect(result.map((r) => r.type)).toEqual(["ROW", "SUBTABLE", "ROW", "GROUP"]);
    expect(result[1]).toBe(subtable);
    expect(result[3]).toBe(group);
  });

  it("SUBTABLE を挟むと行の連続が途切れる", () => {
    const subtable: LayoutRow = { type: "SUBTABLE", code: "t", fields: [] };
    const result = regroupLayout([row("a"), subtable, row("b")]);
    // a と b はまとめない。
    expect(result[0]).toEqual({ type: "ROW", fields: [expect.objectContaining({ code: "a" })] });
    expect(result[2]).toEqual({ type: "ROW", fields: [expect.objectContaining({ code: "b" })] });
  });

  it("group を渡すとそれを優先して組み直す", () => {
    const result = regroupLayout(
      [
        { type: "ROW", fields: [{ code: "publisher", type: "SINGLE_LINE_TEXT" }] },
        { type: "ROW", fields: [{ code: "year", type: "NUMBER" }] },
      ],
      { groups: { publisher: "書誌情報", year: "書誌情報" } },
    );
    expect(result).toHaveLength(1);
    expect((result[0] as { fields: unknown[] }).fields).toHaveLength(2);
  });

  it("すでに横並びの行も系統ごとに組み直す", () => {
    const result = regroupLayout([
      { type: "ROW", fields: [{ code: "a", type: "SINGLE_LINE_TEXT" }, { code: "b", type: "NUMBER" }] },
    ]);
    // 系統が違うので分かれる。
    expect(result).toHaveLength(2);
  });

  it("fields を持たない ROW でも落ちない", () => {
    expect(() => regroupLayout([{ type: "ROW" }])).not.toThrow();
  });
});

describe("describeRows", () => {
  it("行の中身を読める形にする", () => {
    expect(describeRows([fields("a:SINGLE_LINE_TEXT", "b:SINGLE_LINE_TEXT"), fields("c:NUMBER")])).toEqual([
      "a | b",
      "c",
    ]);
  });
});

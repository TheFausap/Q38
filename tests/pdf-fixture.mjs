/**
 * A minimal PDF writer for the tests: pages of Helvetica lines at chosen sizes,
 * which is all the library's extractor looks at. No dependencies, so the tests
 * run anywhere `npm test` does.
 *
 *   makePdf({ title: "…", pages: [[{ size: 18, text: "A title" }, { size: 10, text: "body…" }]] })
 */
function esc(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function makePdf({ title = "", pages }) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids = [];
  for (const lines of pages) {
    let y = 760;
    const ops = ["BT"];
    for (const line of lines) {
      y -= Math.round(line.size * 1.6);
      ops.push(`/F1 ${line.size} Tf 1 0 0 1 72 ${y} Tm (${esc(line.text)}) Tj`);
    }
    ops.push("ET");
    const stream = ops.join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = title ? add(`<< /Title (${esc(title)}) >>`) : 0;

  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A small paper: a masthead, numbered sections, a running head, maths, hyphenation. */
export function samplePaper() {
  const body = (text) => ({ size: 10, text });
  const head = (text) => ({ size: 12, text });
  const running = { size: 8, text: "Preprint under review" };
  const filler = (topic, n) =>
    Array.from({ length: n }, (_, i) =>
      body(`The ${topic} result number ${i + 1} holds because each level updates at its own frequency and stores context.`),
    );
  return makePdf({
    title: "Nested Memories for Continual Learners",
    pages: [
      [
        running,
        { size: 18, text: "Nested Memories for Continual Learners" },
        { size: 12, text: "Ada Example, Bo Sample" },
        { size: 9, text: "Abstract" },
        body("We study memory systems that update at many frequencies and show how they avoid catastrophic forgetting."),
        head("1 Introduction"),
        body("Continual learning asks a model to keep what it knew while it learns some-"),
        body("thing new. Fast weights help, but slow weights hold the knowledge that lasts."),
        ...filler("introductory", 8),
      ],
      [
        running,
        head("2 Continuum Memory System"),
        body("A continuum memory system is a chain of blocks, each with its own update frequency."),
        { size: 12, text: "M(0) := M(0)(x; W) (24)" },
        ...filler("frequency", 14),
        { size: 10, text: "2" },
      ],
      [
        running,
        head("3 Experiments"),
        body("We measure perplexity on long documents and recall on needle-in-a-haystack tasks."),
        ...filler("experimental", 10),
        head("References"),
        body("[1] A. Example. On memories. 2025."),
      ],
      [running, head("A Proofs"), ...filler("appendix", 6)],
    ],
  });
}

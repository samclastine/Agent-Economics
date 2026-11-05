/**
 * Financial-document layout engine for Agent Treasury receipts.
 * Stripe/bank-style: dark header band, status, hero amount, sectioned
 * label/value rows, party columns, mono evidence blocks, footer with
 * document id + page numbers. Built on pdf-lib.
 */
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'pdf-lib';

const W = 595.28;
const H = 841.89;
const M = 48;
const INK = rgb(0.11, 0.12, 0.16);
const MUTED = rgb(0.42, 0.45, 0.52);
const FAINT = rgb(0.62, 0.65, 0.72);
const LINE = rgb(0.86, 0.88, 0.92);
const BAND = rgb(0.07, 0.09, 0.16);
const GREEN = rgb(0.05, 0.55, 0.32);
const AMBER = rgb(0.75, 0.45, 0.05);

// Standard 14 fonts encode WinAnsi (CP1252) — strip anything outside it.
const NOT_WINANSI = /[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g;
const san = (s: string) => s.replace(NOT_WINANSI, '?');

function shortHash(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

export class ReceiptDoc {
  private pdf!: PDFDocument;
  private page!: PDFPage;
  private helv!: PDFFont;
  private helvB!: PDFFont;
  private courier!: PDFFont;
  private y = 0;
  private pageNo = 0;

  readonly receiptId: string;
  readonly jobId: string;
  private docType: string;
  private status: string;
  private statusColor = GREEN;
  private generated = new Date().toISOString();

  constructor(opts: {
    docType: string; title: string; status: string;
    receiptId: string; jobId: string; statusColor?: 'green' | 'amber' | 'red';
  }) {
    this.docType = opts.docType;
    this.receiptId = opts.receiptId;
    this.jobId = opts.jobId;
    this.status = opts.status;
    if (opts.statusColor === 'amber') this.statusColor = AMBER;
    if (opts.statusColor === 'red') this.statusColor = rgb(0.7, 0.15, 0.15);
    this.title = opts.title;
  }
  private title: string;

  static async create(opts: ConstructorParameters<typeof ReceiptDoc>[0]): Promise<ReceiptDoc> {
    const d = new ReceiptDoc(opts);
    await d.init();
    return d;
  }

  private async init() {
    this.pdf = await PDFDocument.create();
    this.helv = await this.pdf.embedFont(StandardFonts.Helvetica);
    this.helvB = await this.pdf.embedFont(StandardFonts.HelveticaBold);
    this.courier = await this.pdf.embedFont(StandardFonts.Courier);
    this.newPage();
    this.drawHeader();
  }

  private dt(text: string, opts: Parameters<PDFPage['drawText']>[1]) {
    this.page.drawText(san(text), opts);
  }

  private newPage() {
    this.page = this.pdf.addPage([W, H]);
    this.pageNo += 1;
    this.y = H - M;
    // footer on every page (page numbers patched at build time)
    this.dt(`Agent Treasury · ${this.docType}`, { x: M, y: 30, size: 7.5, font: this.helv, color: FAINT });
    this.dt(`Doc ${this.receiptId} · Job ${this.jobId.slice(0, 8)}`, { x: W - M - 190, y: 30, size: 7.5, font: this.courier, color: FAINT });
  }

  private ensure(h: number) {
    if (this.y - h < 64) this.newPage();
  }

  private drawHeader() {
    // dark band
    this.page.drawRectangle({ x: 0, y: H - 110, width: W, height: 110, color: BAND });
    this.dt('AGENT TREASURY', { x: M, y: H - 42, size: 10, font: this.helvB, color: rgb(0.75, 0.8, 0.95) });
    this.dt(this.docType.toUpperCase(), { x: M, y: H - 68, size: 20, font: this.helvB, color: rgb(1, 1, 1) });
    this.dt(this.title, { x: M, y: H - 90, size: 9, font: this.helv, color: rgb(0.6, 0.66, 0.8) });
    // status pill
    const label = this.status.toUpperCase();
    const tw = this.helvB.widthOfTextAtSize(label, 8);
    const px = W - M - tw - 20;
    this.page.drawRectangle({ x: px - 10, y: H - 78, width: tw + 20, height: 18, color: this.statusColor });
    this.dt(label, { x: px, y: H - 73, size: 8, font: this.helvB, color: rgb(1, 1, 1) });
    this.y = H - 140;
  }

  /** Big centered amount + caption (e.g. "50.00 tWIF / Escrow secured"). */
  hero(amount: string, caption: string) {
    this.ensure(110);
    this.y -= 14;
    this.dt(caption.toUpperCase(), { x: M, y: this.y, size: 8, font: this.helvB, color: MUTED });
    this.y -= 30;
    this.dt(amount, { x: M, y: this.y, size: 26, font: this.helvB, color: INK });
    this.y -= 18;
    this.page.drawLine({ start: { x: M + 120, y: this.y }, end: { x: W - M - 120, y: this.y }, thickness: 0.7, color: LINE });
    this.y -= 16;
  }

  /** Section header: small caps label + hairline. */
  section(label: string) {
    this.ensure(40);
    this.y -= 8;
    this.dt(label.toUpperCase(), { x: M, y: this.y, size: 8.5, font: this.helvB, color: MUTED });
    this.y -= 6;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness: 0.7, color: LINE });
    this.y -= 14;
  }

  /** Label/value row; wraps long values. */
  kv(label: string, value: string, opts: { mono?: boolean; strong?: boolean } = {}) {
    const font = opts.mono ? this.courier : opts.strong ? this.helvB : this.helv;
    const size = opts.mono ? 8 : 9.5;
    const lines = this.wrap(value, font, size, W - M * 2 - 150);
    const lh = size * 1.35;
    this.ensure(lines.length * lh + 16);
    this.dt(label, { x: M, y: this.y, size: 9, font: this.helv, color: MUTED });
    let vy = this.y;
    for (const ln of lines) {
      this.dt(ln, { x: M + 150, y: vy, size, font, color: INK });
      vy -= lh;
    }
    // vy is now one leading below the last value line — leave clear air.
    this.y = vy - 8;
  }

  /** Full-width wrapped paragraph (descriptions, criteria). */
  para(text: string, opts: { size?: number; color?: typeof MUTED } = {}) {
    const font = this.helv;
    const size = opts.size ?? 9;
    for (const ln of this.wrap(text, font, size, W - M * 2)) {
      this.ensure(size * 1.4);
      this.dt(ln, { x: M, y: this.y, size, font, color: opts.color ?? INK });
      this.y -= size * 1.35;
    }
    this.y -= 2;
  }

  /** Two side-by-side party cards; rows grow to fit wrapped values. */
  parties(left: { title: string; rows: [string, string][] }, right: { title: string; rows: [string, string][] }) {
    const colW = (W - M * 2 - 16) / 2;
    const wrapRow = (v: string) => this.wrap(v, this.helvB, 8.5, colW - 90).slice(0, 2);
    const laid = [left, right].map((col) =>
      col.rows.map(([k, v]) => ({ k, v: wrapRow(v) })),
    );
    const heights = laid.map((rows) =>
      26 + rows.reduce((h, r) => h + Math.max(14, r.v.length * 10 + 4), 0) + 8,
    );
    const height = Math.max(...heights);
    this.ensure(height + 10);
    for (const [i, col] of [left, right].entries()) {
      const x = M + i * (colW + 16);
      const rows = laid[i];
      this.page.drawRectangle({ x, y: this.y - height + 14, width: colW, height, color: rgb(0.97, 0.98, 0.99), borderColor: LINE, borderWidth: 0.7 });
      this.dt(col.title.toUpperCase(), { x: x + 10, y: this.y - 4, size: 8, font: this.helvB, color: MUTED });
      let ry = this.y - 22;
      for (const r of rows) {
        this.dt(r.k, { x: x + 10, y: ry, size: 8, font: this.helv, color: FAINT });
        r.v.forEach((ln, j) => this.dt(ln, { x: x + 80, y: ry - j * 10, size: 8.5, font: this.helvB, color: INK }));
        ry -= Math.max(14, r.v.length * 10 + 4);
      }
    }
    this.y -= height + 10;
  }

  /** Bullet-ish evidence lines in mono. */
  mono(lines: string[]) {
    for (const ln of lines) {
      for (const w of this.wrap(ln, this.courier, 8, W - M * 2 - 14)) {
        this.ensure(11);
        this.dt(w, { x: M + 14, y: this.y, size: 8, font: this.courier, color: INK });
        this.y -= 11;
      }
    }
    this.y -= 4;
  }

  /** Legal/footer note. */
  note(text: string) {
    for (const ln of this.wrap(text, this.helv, 8, W - M * 2)) {
      this.ensure(12);
      this.dt(ln, { x: M, y: this.y, size: 8, font: this.helv, color: MUTED });
      this.y -= 10;
    }
  }

  private wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
    const out: string[] = [];
    for (const raw of text.split('\n')) {
      if (!raw) { out.push(''); continue; }
      let line = '';
      for (const word of raw.split(' ')) {
        const cand = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(cand, size) <= maxW) { line = cand; continue; }
        if (line) out.push(line);
        // Word itself too wide — hard-split by characters so nothing overruns.
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > maxW && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxW) cut--;
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      if (line) out.push(line);
    }
    return out;
  }

  async build(): Promise<Uint8Array> {
    // stamp page numbers into footers
    const total = this.pdf.getPageCount();
    for (let i = 0; i < total; i++) {
      const p = this.pdf.getPage(i);
      p.drawText(`Page ${i + 1} of ${total}`, { x: W - M - 60, y: 30, size: 7.5, font: this.helv, color: FAINT });
      p.drawText(`Generated ${this.generated}`, { x: M, y: 16, size: 7, font: this.helv, color: FAINT });
    }
    return this.pdf.save();
  }
}

export { shortHash };

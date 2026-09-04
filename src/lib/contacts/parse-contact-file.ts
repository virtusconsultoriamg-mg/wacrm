import {
  parseContactCsv,
  type ParseContactCsvResult,
} from './parse-contact-csv';

/**
 * Parse the contact import formats supported by the CRM.
 * CSV stays dependency-free; XLSX is parsed in-browser using the platform's
 * ZIP + XML APIs so the import flow does not add a large spreadsheet bundle.
 */
export async function parseContactFile(
  file: File
): Promise<ParseContactCsvResult> {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  if (extension === 'csv' || file.type === 'text/csv') {
    return parseContactCsv(await file.text());
  }
  if (
    extension === 'xlsx' ||
    file.type ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return parseContactXlsx(await file.arrayBuffer());
  }
  return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
}

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

async function parseContactXlsx(
  buffer: ArrayBuffer
): Promise<ParseContactCsvResult> {
  const files = await readZipEntries(buffer);
  const sharedStrings = files.has('xl/sharedStrings.xml')
    ? parseSharedStrings(
        await readZipFile(buffer, files.get('xl/sharedStrings.xml')!)
      )
    : [];

  // Excel normally stores the first worksheet here. For workbooks with a
  // different first-sheet path, fall back to the first xl/worksheets/*.xml.
  const sheetEntry =
    files.get('xl/worksheets/sheet1.xml') ??
    [...files.entries()].find(([name]) =>
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
    )?.[1];
  if (!sheetEntry)
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };

  const xml = new TextDecoder().decode(await readZipFile(buffer, sheetEntry));
  const rows = parseWorksheet(xml, sharedStrings);
  if (rows.length < 2)
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };

  const headers = rows[0].map(normalizeHeader);
  const phoneIdx = findHeader(headers, [
    'phone',
    'telefone',
    'celular',
    'whatsapp',
    'mobile',
  ]);
  if (phoneIdx < 0)
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };

  const nameIdx = findHeader(headers, ['name', 'nome']);
  const emailIdx = findHeader(headers, ['email', 'e-mail']);
  const companyIdx = findHeader(headers, ['company', 'empresa']);
  const tagsIdx = findHeader(headers, ['tags', 'tag', 'etiquetas']);

  const parsed = rows.slice(1).flatMap((values) => {
    const phone = values[phoneIdx]?.trim();
    if (!phone) return [];
    return [
      {
        phone,
        name: valueAt(values, nameIdx),
        email: valueAt(values, emailIdx),
        company: valueAt(values, companyIdx),
        tagNames: tagsIdx >= 0 ? parseTagNames(values[tagsIdx]) : [],
      },
    ];
  });

  return {
    rows: parsed,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
  };
}

function valueAt(values: string[], index: number): string | undefined {
  if (index < 0) return undefined;
  const value = values[index]?.trim();
  return value || undefined;
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function findHeader(headers: string[], candidates: string[]): number {
  const normalized = new Set(candidates.map(normalizeHeader));
  return headers.findIndex((header) => normalized.has(header));
}

function parseTagNames(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const seen = new Set<string>();
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function parseSharedStrings(xml: Uint8Array): string[] {
  const text = new TextDecoder().decode(xml);
  const values: string[] = [];
  for (const match of text.matchAll(/<si[\s\S]*?<\/si>/g)) {
    const value = [...match[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((m) => decodeXml(m[1]))
      .join('');
    values.push(value);
  }
  return values;
}

function parseWorksheet(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowXml = rowMatch[1];
    const values: string[] = [];
    for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const cellXml = cellMatch[2];
      const ref = attrs.match(/\br="([A-Z]+)\d*"/)?.[1];
      if (!ref) continue;
      const index = columnIndex(ref);
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      let value = '';
      const inline = cellXml.match(
        /<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>[\s\S]*?<\/is>/
      );
      const raw = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (inline) value = decodeXml(inline[1]);
      else if (raw !== undefined) {
        const decoded = decodeXml(raw);
        value = type === 's' ? (sharedStrings[Number(decoded)] ?? '') : decoded;
      }
      values[index] = value;
    }
    rows.push(values.map((value) => value ?? ''));
  }
  return rows;
}

function columnIndex(column: string): number {
  let index = 0;
  for (const char of column) index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function readZipEntries(
  buffer: ArrayBuffer
): Promise<Map<string, ZipEntry>> {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error('Arquivo XLSX inválido.');
  const centralOffset = view.getUint32(eocd + 16, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50)
      throw new Error('Arquivo XLSX inválido.');
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(
      new Uint8Array(buffer, offset + 46, nameLength)
    );
    entries.set(name, {
      name,
      compression,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= min; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

async function readZipFile(
  buffer: ArrayBuffer,
  entry: ZipEntry
): Promise<Uint8Array> {
  const view = new DataView(buffer);
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== 0x04034b50)
    throw new Error('Arquivo XLSX inválido.');
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = new Uint8Array(buffer, start, entry.compressedSize);
  if (entry.compression === 0) return compressed;
  if (entry.compression !== 8 || typeof DecompressionStream === 'undefined') {
    throw new Error(
      'Este navegador não consegue abrir arquivos XLSX compactados.'
    );
  }
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  if (entry.uncompressedSize && bytes.byteLength !== entry.uncompressedSize) {
    throw new Error('Arquivo XLSX corrompido.');
  }
  return bytes;
}

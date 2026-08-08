/**
 * S32-A 导入中心 V2 —— 零依赖表格编解码
 *
 * 由于受限环境无法安装 exceljs/xlsx，这里用 Node 内置 zlib 实现：
 *   - CSV：自研解析器（支持引号转义 / 内嵌换行 / BOM）
 *   - XLSX：最小 ZIP + OOXML 读取器 / 写入器（覆盖 Excel 常用输出：
 *     sharedStrings、inlineStr、数字、日期即数值）
 *
 * 适用范围说明：
 *   - 读取：Excel/Google Sheets 导出的常规 .xlsx（字符串走 sharedStrings/inlineStr）。
 *   - 生成：本中心模板 .xlsx（单 sheet + sharedStrings，Excel/WPS 可直接打开）。
 *   - 若遇到非常规结构（加密 / 宏 / 复杂样式 zip flag bit3），读取会返回空表，
 *     上层给出"请另存为 CSV 后上传"的明确提示。
 */
import zlib from 'node:zlib'

// ============================================================
// CRC32（标准 IEEE，替代依赖 zlib.crc32 的版本门槛）
// ============================================================
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ============================================================
// 最小 ZIP 写入器（deflate，无 data descriptor）
// ============================================================

interface ZipEntry {
  name: string
  data: Buffer
}

/** 构建一个可在 Excel/WPS/7z 中打开的 ZIP 归档（含中央目录） */
export function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const comp = zlib.deflateRawSync(entry.data)
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)   // PK\x03\x04
    local.writeUInt16LE(20, 4)           // version needed
    local.writeUInt16LE(0x0800, 6)       // flags: UTF-8 filename
    local.writeUInt16LE(8, 8)            // method: deflate
    local.writeUInt16LE(0, 10)           // mod time
    local.writeUInt16LE(0, 12)           // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)           // extra len
    chunks.push(local, nameBuf, comp)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)     // PK\x01\x02
    cen.writeUInt16LE(20, 4)             // version made by
    cen.writeUInt16LE(20, 6)             // version needed
    cen.writeUInt16LE(0x0800, 8)         // flags
    cen.writeUInt16LE(8, 10)             // method
    cen.writeUInt16LE(0, 12)             // time
    cen.writeUInt16LE(0, 14)             // date
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(comp.length, 20)
    cen.writeUInt32LE(entry.data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30)             // extra len
    cen.writeUInt16LE(0, 32)             // comment len
    cen.writeUInt16LE(0, 34)             // disk start
    cen.writeUInt16LE(0, 36)             // internal attrs
    cen.writeUInt32LE(0, 38)             // external attrs
    cen.writeUInt32LE(offset, 42)        // local header offset
    central.push(cen, nameBuf)

    offset += 30 + nameBuf.length + comp.length
  }

  const cdStart = offset
  const cdSize = central.reduce((s, b) => s + b.length, 0)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)      // PK\x05\x06
  eocd.writeUInt16LE(0, 4)               // disk num
  eocd.writeUInt16LE(0, 6)               // disk with cd
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdStart, 16)
  eocd.writeUInt16LE(0, 20)              // comment len

  return Buffer.concat([...chunks, ...central, eocd])
}

// ============================================================
// 最小 ZIP 读取器（按本地文件头扫描，支持 stored/deflate）
// ============================================================

/** 解析 ZIP 归档，返回 文件名 → 解压后内容 */
export function parseZipEntries(buf: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>()
  let pos = 0
  while (pos + 30 <= buf.length) {
    if (buf.readUInt32LE(pos) !== 0x04034b50) {
      pos++
      continue
    }
    const flags = buf.readUInt16LE(pos + 6)
    const method = buf.readUInt16LE(pos + 8)
    const compSize = buf.readUInt32LE(pos + 18)
    const uncompSize = buf.readUInt32LE(pos + 22)
    const nameLen = buf.readUInt16LE(pos + 26)
    const extraLen = buf.readUInt16LE(pos + 28)

    const nameStart = pos + 30
    const name = buf.toString('utf8', nameStart, nameStart + nameLen)
    const dataStart = nameStart + nameLen + extraLen

    // 第 3 位标记:本地头中尺寸可能为 0，数据后有 data descriptor —— 非常规文件，跳过
    if ((flags & 0x0008) !== 0 || dataStart + compSize > buf.length) {
      // 无法安全定位，直接放弃扫描
      break
    }

    const comp = buf.subarray(dataStart, dataStart + compSize)
    let data: Buffer
    try {
      data = method === 0
        ? Buffer.from(comp)
        : method === 8
          ? zlib.inflateRawSync(comp)
          : Buffer.alloc(0)
    }
    catch {
      data = Buffer.alloc(0)
    }
    if (uncompSize > 0 && data.length === 0) {
      // 解压失败，跳过
    }
    if (name) {
      result.set(name, data)
    }
    pos = dataStart + compSize
  }
  return result
}

// ============================================================
// OOXML 解析辅助
// ============================================================

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function parseAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_][\w:.-]*)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrs))) {
    out[m[1]] = m[2]
  }
  return out
}

/** 单元格引用列号：A→0, B→1, AA→26 */
function colIndexFromRef(ref: string): number {
  let col = 0
  for (let i = 0; i < ref.length; i++) {
    const ch = ref.charCodeAt(i)
    if (ch >= 65 && ch <= 90) {
      col = col * 26 + (ch - 64)
    }
    else {
      break
    }
  }
  return col - 1
}

/** 提取 <t>...</t> 文本（拼接 rich text runs） */
function extractText(xml: string): string {
  const parts: string[] = []
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    parts.push(m[1])
  }
  return parts.join('')
}

// ============================================================
// XLSX 读取
// ============================================================

/** 解析 .xlsx 字节为二维字符串表 */
export function parseXlsx(buf: Buffer): string[][] {
  const entries = parseZipEntries(buf)
  const sharedRaw = entries.get('xl/sharedStrings.xml')
  const sheetRaw = entries.get('xl/worksheets/sheet1.xml')
  if (!sheetRaw) {
    return []
  }

  const shared: string[] = []
  if (sharedRaw) {
    const sst = sharedRaw.toString('utf8')
    const siRe = /<si[\s\S]*?<\/si>/g
    let m: RegExpExecArray | null
    while ((m = siRe.exec(sst))) {
      shared.push(extractText(m[0]))
    }
  }

  const sheetXml = sheetRaw.toString('utf8')
  const rows: string[][] = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(sheetXml))) {
    const rowBody = rm[1]
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    const cellsByCol = new Map<number, string>()
    let maxCol = -1
    let cm: RegExpExecArray | null
    while ((cm = cellRe.exec(rowBody))) {
      const attrs = parseAttrs(cm[1])
      const ref = attrs.r || ''
      const col = ref ? colIndexFromRef(ref) : maxCol + 1
      const t = attrs.t || ''
      let value = ''
      if (cm[2] !== undefined) {
        const body = cm[2]
        if (t === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
          const idx = Number(v)
          value = Number.isFinite(idx) ? (shared[idx] ?? '') : ''
        }
        else if (t === 'inlineStr' || t === 'str') {
          value = extractText(body)
        }
        else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
          value = v ?? ''
        }
      }
      if (col > maxCol) {
        maxCol = col
      }
      cellsByCol.set(col, value)
    }
    const row: string[] = []
    for (let i = 0; i <= maxCol; i++) {
      row.push(cellsByCol.get(i) ?? '')
    }
    rows.push(row)
  }
  return rows
}

// ============================================================
// XLSX 写入（最小单 sheet）
// ============================================================

/**
 * 生成一个可被 Excel/WPS 打开的 .xlsx 字节
 * @param rows 二维字符串表
 * @param sheetName sheet 名（默认"模板"）
 */
export function buildXlsx(rows: string[][], sheetName = '模板'): Buffer {
  // 收集去重字符串
  const seen = new Map<string, number>()
  const shared: string[] = []
  const sharedIndex = (s: string): number => {
    const hit = seen.get(s)
    if (hit !== undefined) {
      return hit
    }
    const idx = shared.length
    shared.push(s)
    seen.set(s, idx)
    return idx
  }

  // 转成单元格：字符串→shared index；空→空
  const sheetRows: string[] = []
  for (let r = 0; r < rows.length; r++) {
    const rowCells: string[] = []
    for (let c = 0; c < rows[r].length; c++) {
      const val = rows[r][c]
      if (val === '') {
        continue
      }
      const colRef = `${colLetter(c)}${r + 1}`
      rowCells.push(`<c r="${colRef}" t="s"><v>${sharedIndex(val)}</v></c>`)
    }
    sheetRows.push(`<row r="${r + 1}">${rowCells.join('')}</row>`)
  }

  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map(s => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('') +
    `</sst>`

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows.join('')}</sheetData>` +
    `</worksheet>`

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(relsXml, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRelsXml, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedXml, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml, 'utf8') },
  ]
  return buildZip(entries)
}

/** 0→A, 1→B, 26→AA */
function colLetter(col: number): string {
  let n = col + 1
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// ============================================================
// CSV 读取
// ============================================================

/** 解析 CSV 文本为二维字符串表（RFC4180 子集：引号/转义/内嵌换行/BOM） */
export function parseCsv(text: string): string[][] {
  let s = text
  if (s.charCodeAt(0) === 0xFEFF) {
    s = s.slice(1)
  }
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        }
        else {
          inQuotes = false
        }
      }
      else {
        field += ch
      }
    }
    else if (ch === '"') {
      inQuotes = true
    }
    else if (ch === ',') {
      pushField()
    }
    else if (ch === '\n') {
      pushRow()
    }
    else if (ch === '\r') {
      // \r\n 或单独 \r 都视为换行
      if (s[i + 1] === '\n') {
        i++
      }
      pushRow()
    }
    else {
      field += ch
    }
  }
  // 尾部
  if (field.length > 0 || row.length > 0) {
    pushRow()
  }
  return rows
}

// ============================================================
// 统一入口
// ============================================================

export interface ParsedTable {
  headers: string[]
  rows: string[][]
}

/** 按文件名/MIME 解析为表格；不支持的类型抛错 */
export function parseSpreadsheet(buf: Buffer, filename: string, mime?: string): ParsedTable {
  const lower = filename.toLowerCase()
  const isCsv = lower.endsWith('.csv') || (mime && (mime.includes('text/csv') || mime.includes('application/csv')))
  const isXlsx = lower.endsWith('.xlsx') || (mime && mime.includes('spreadsheetml'))

  if (isCsv) {
    return { headers: [], rows: parseCsv(buf.toString('utf8')) }
  }
  if (isXlsx) {
    return { headers: [], rows: parseXlsx(buf) }
  }
  throw new Error('UNSUPPORTED_FILE_TYPE')
}

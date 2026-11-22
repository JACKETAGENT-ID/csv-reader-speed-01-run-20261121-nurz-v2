// Fast drop-in replacement for csv-reader 1.0.0.
//
// Strategy: one left-to-right pass over the text with charCodeAt dispatch.
// Fields are never built character by character: the parser remembers the
// start index of the current span and emits text.slice(start, end) for the
// common contiguous case. Only fields that need surgery (doubled quotes,
// CR/CRLF normalised inside quotes, stray CRs dropped outside quotes, or
// junk appended after a closing quote) collect span parts in a small array
// and join them once.

export function run(input) {
  const t = String(input.text);
  const header = input.header === true;
  const n = t.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let i = 0; // cursor
  let line = 1; // line the cursor is on
  if (n > 0 && t.charCodeAt(0) === 0xfeff) i = 1;

  // Outer loop: one iteration per record.
  for (;;) {
    // A line with no characters is no record: skip bare LF / CRLF breaks.
    while (i < n) {
      const c = t.charCodeAt(i);
      if (c === 10) { i += 1; line += 1; }
      else if (c === 13 && i + 1 < n && t.charCodeAt(i + 1) === 10) { i += 2; line += 1; }
      else break;
    }
    if (i >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    let ended = 2; // 0 = comma (record goes on), 1 = line break, 2 = end of text

    // Field loop: one iteration per field of this record.
    for (;;) {
      lastQuoted = false;
      let value = '';
      let prefix = null; // non-null: an unquoted scan follows with this prefix
      let junkMode = false;
      let fieldDone = false;

      if (i < n && t.charCodeAt(i) === 34) {
        // ---- quoted field ----
        lastQuoted = true;
        const open = i;
        const openLine = line;
        i += 1;
        let seg = i;
        let buf = null;
        let closed = false;
        while (i < n) {
          const c = t.charCodeAt(i);
          if (c === 34) {
            if (i + 1 < n && t.charCodeAt(i + 1) === 34) {
              if (buf === null) buf = [t.slice(seg, i)]; else buf.push(t.slice(seg, i));
              buf.push('"');
              i += 2; seg = i;
            } else {
              if (buf === null) value = t.slice(seg, i);
              else { buf.push(t.slice(seg, i)); value = buf.join(''); }
              i += 1; closed = true;
              break;
            }
          } else if (c === 13) {
            if (buf === null) buf = [t.slice(seg, i)]; else buf.push(t.slice(seg, i));
            buf.push('\n');
            line += 1;
            i += i + 1 < n && t.charCodeAt(i + 1) === 10 ? 2 : 1;
            seg = i;
          } else {
            if (c === 10) line += 1;
            i += 1;
          }
        }
        if (!closed) {
          // Never closed: the quote is a literal char, the rest is re-read
          // as an unquoted field starting just after the opening quote.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          i = open + 1;
          line = openLine;
          prefix = '"';
        } else if (i >= n) {
          ended = 2;
          fieldDone = true;
        } else {
          const c = t.charCodeAt(i);
          if (c === 44) { i += 1; ended = 0; fieldDone = true; }
          else if (c === 10) { i += 1; line += 1; ended = 1; fieldDone = true; }
          else if (c === 13 && i + 1 < n && t.charCodeAt(i + 1) === 10) { i += 2; line += 1; ended = 1; fieldDone = true; }
          else { prefix = value; junkMode = true; }
        }
        if (fieldDone) fields.push(value);
      } else {
        prefix = '';
      }

      if (prefix !== null) {
        // ---- unquoted scan (plain field, unterminated re-read, or junk) ----
        let seg = i;
        let buf = null;
        let added = 0;
        if (prefix !== '') buf = [prefix];
        ended = 2;
        scan: while (i < n) {
          const c = t.charCodeAt(i);
          if (c === 44) {
            added += i - seg;
            value = buf === null ? t.slice(seg, i) : (buf.push(t.slice(seg, i)), buf.join(''));
            i += 1; ended = 0;
            break scan;
          }
          if (c === 10) {
            added += i - seg;
            value = buf === null ? t.slice(seg, i) : (buf.push(t.slice(seg, i)), buf.join(''));
            i += 1; line += 1; ended = 1;
            break scan;
          }
          if (c === 13) {
            if (i + 1 < n && t.charCodeAt(i + 1) === 10) {
              added += i - seg;
              value = buf === null ? t.slice(seg, i) : (buf.push(t.slice(seg, i)), buf.join(''));
              i += 2; line += 1; ended = 1;
              break scan;
            }
            // Stray CR outside quotes: dropped, error recorded.
            if (buf === null) buf = [t.slice(seg, i)]; else buf.push(t.slice(seg, i));
            added += i - seg;
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            i += 1; seg = i;
            continue scan;
          }
          i += 1;
        }
        if (ended === 2 && i >= n) {
          // Ran off the end of the text while scanning.
          added += i - seg;
          value = buf === null ? t.slice(seg, i) : (buf.push(t.slice(seg, i)), buf.join(''));
        }
        if (junkMode && added > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
        fields.push(value);
      }

      if (ended !== 0) break;
    }

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// ════════════════════════════════════════════════════════════════
// UPLOAD FILE-TYPE GATE — the extensions no upload may carry.
//
// Deliberately a DENY list, not an allow list. Uploads here are a genuine
// grab-bag: STL/3MF/STEP models, g-code in a dozen slicer dialects, PDFs,
// images, and the order-attachments dropzone whose whole promise is
// "anything the customer hands over". An allow list would have to be
// re-opened every time a customer emails a .dxf, and each of those edits is
// a chance to lock an operator out of their own job. A deny list refuses the
// handful of things that are never a print job and never an attachment.
//
// What lands here is web-executable source: PHP and JSP. Neither has any use
// in a 3D-printing shop, and both are what a bucket gets probed for. Today
// nothing in this stack would execute them — objects live in Supabase
// Storage, and the serve route (uploads.controller.ts) is a Nest handler that
// answers application/octet-stream. This is a gate against the day that stops
// being true: a CDN put in front of the bucket, a future static mount, an
// operator who downloads the "attachment" and double-clicks it. Refusing the
// bytes at the door costs nothing; storing them and relying on every future
// reader to stay careful does.
//
// Pure module — no Nest decorators, no imports — so Node's strip-only
// TypeScript loader can require it straight from a test. Callers turn a hit
// into whatever HTTP error suits them.
//
// Covered by test/upload-file-types.test.ts.
// ════════════════════════════════════════════════════════════════

const BLOCKED_UPLOAD_EXTENSIONS = new Set<string>([
  // PHP. Not just ".php": a stock Apache/php-fpm config maps a whole family,
  // and a gate that stops ".php" while waving through ".phtml" is not a gate.
  // ".phar" is a PHP archive, which the runtime executes the same way.
  ".php", ".php2", ".php3", ".php4", ".php5", ".php6", ".php7", ".php8",
  ".phps", ".pht", ".phtm", ".phtml", ".phar",
  // JSP. Tomcat maps *.jsp and *.jspx out of the box; the rest are the
  // extra JspServlet mappings that turn up in servlet-container deployments.
  ".jsp", ".jspx", ".jspf", ".jsw", ".jsv", ".jtml",
]);

// None of the above collides with anything this app actually takes — models
// (.stl .3mf .obj .step .stp), slicer output (.gcode .gco .g .bgcode .gx .ctb
// .3mf .zip), or paperwork (.pdf .png .jpg .jpeg .gif .webp .svg .txt .csv).
export const BLOCKED_UPLOAD_EXTENSION_LIST: readonly string[] =
  Object.freeze([...BLOCKED_UPLOAD_EXTENSIONS]);

// The filename arrives verbatim from the multipart part — it is the client's
// string, not ours, so every assumption about its shape has to be spelled out.
function normalizeUploadFilename(raw: string): string {
  // Some pickers (legacy IE, a few mobile browsers) send a full path. Only the
  // last segment names the file.
  const base = raw.split(/[\/]/).pop() ?? "";
  return base
    // "shell.php\0.stl" — anything that truncates at the NUL sees .php while a
    // naive extname() sees .stl. Drop the NULs and the decoy loses its point.
    .replace(/\0/g, "")
    .toLowerCase()
    // Windows discards trailing dots and spaces, so "shell.php." and
    // "shell.php " both open as shell.php.
    .replace(/[.\s]+$/, "");
}

/**
 * The blocked extension this filename carries, or null if it carries none.
 *
 * Checks EVERY dot-segment, not only the last one, so "shell.php.stl" is
 * refused. The upload path renames to `<uuid><last-ext>`, which already drops
 * an interior ".php" — but the original name is kept on the row and shown back
 * to the operator, and the admin invoice path (subscription-invoice.service)
 * keeps the original name in the storage key outright. The honest rule is
 * "this is a PHP file", not "this file's last four characters are .php".
 */
export function blockedUploadExtension(filename: string): string | null {
  const name = normalizeUploadFilename(filename);
  if (!name) return null;
  // slice(1) drops the stem: "shell.php" → ["php"], "a.b.php" → ["b", "php"].
  for (const segment of name.split(".").slice(1)) {
    // Trailing junk on a segment ("shell.php;", "shell.php:Zone.Identifier")
    // is the other half of the parser-confusion trick; compare the leading
    // alphanumeric run only.
    const leading = /^[a-z0-9]+/.exec(segment);
    if (!leading) continue;
    const ext = `.${leading[0]}`;
    if (BLOCKED_UPLOAD_EXTENSIONS.has(ext)) return ext;
  }
  return null;
}

/** The one refusal message, so both upload paths say the same thing. */
export function blockedUploadMessage(ext: string): string {
  return `${ext} files are not accepted. Web-executable file types (PHP, JSP) are refused at upload.`;
}

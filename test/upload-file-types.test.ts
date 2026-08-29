// Pure unit tests for the upload file-type gate. No database, no HTTP.
//
// The point of pinning these here is that the interesting cases are all
// filenames a person would never type. The gate reads an attacker-controlled
// string, and every normalization step in it exists because some filename
// shape makes a naive `path.extname()` disagree with what a reader — a CDN, a
// browser, a double-clicking operator — would call the file.
//
// Run: node --test "test/upload-file-types.test.ts"   (see package.json scripts)

import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_UPLOAD_EXTENSION_LIST,
  blockedUploadExtension,
  blockedUploadMessage,
} from "../src/common/upload-file-types.ts";

// ── The ask: .php and .jsp ──────────────────────────────────────────────────

test("blocks the two extensions the gate exists for", () => {
  assert.equal(blockedUploadExtension("shell.php"), ".php");
  assert.equal(blockedUploadExtension("shell.jsp"), ".jsp");
});

test("blocks the rest of each family, not just the headline extension", () => {
  for (const name of ["x.phtml", "x.php5", "x.pht", "x.phps", "x.phar"]) {
    assert.equal(blockedUploadExtension(name), name.slice(1), name);
  }
  for (const name of ["x.jspx", "x.jspf", "x.jsw", "x.jsv", "x.jtml"]) {
    assert.equal(blockedUploadExtension(name), name.slice(1), name);
  }
});

test("case does not matter", () => {
  assert.equal(blockedUploadExtension("Shell.PHP"), ".php");
  assert.equal(blockedUploadExtension("SHELL.JsPx"), ".jspx");
});

// ── Normalization: the shapes that fool path.extname() ──────────────────────

test("a double extension is caught on the inner segment", () => {
  // path.extname() reports ".stl" here and would let it through.
  assert.equal(blockedUploadExtension("shell.php.stl"), ".php");
  assert.equal(blockedUploadExtension("invoice.jsp.pdf"), ".jsp");
});

test("a trailing dot or space is stripped, the way Windows strips it", () => {
  assert.equal(blockedUploadExtension("shell.php."), ".php");
  assert.equal(blockedUploadExtension("shell.php   "), ".php");
  assert.equal(blockedUploadExtension("shell.php. . ."), ".php");
});

test("a NUL decoy does not hide the real extension", () => {
  assert.equal(blockedUploadExtension("shell.php\0.stl"), ".php");
});

test("junk appended to the segment does not disguise it", () => {
  assert.equal(blockedUploadExtension("shell.php;.stl"), ".php");
  assert.equal(blockedUploadExtension("shell.php:Zone.Identifier"), ".php");
});

test("a directory prefix is discarded before matching", () => {
  assert.equal(blockedUploadExtension("C:\\Users\\op\\Desktop\\shell.php"), ".php");
  assert.equal(blockedUploadExtension("../../etc/shell.php"), ".php");
  // ...and a blocked word in a FOLDER name is not a blocked file.
  assert.equal(blockedUploadExtension("/srv/www.php/bracket.stl"), null);
});

test("a dotfile named after the extension is still that extension", () => {
  assert.equal(blockedUploadExtension(".php"), ".php");
});

// ── The half that matters more: everything real still gets in ───────────────

test("every file type this app actually takes is allowed", () => {
  const allowed = [
    "bracket.stl", "plate.3mf", "mesh.obj", "part.step", "part.stp",
    "print.gcode", "print.gco", "print.g", "print.bgcode", "print.gx",
    "print.ctb", "plate.slicer", "batch.zip",
    "invoice.pdf", "logo.png", "photo.jpg", "photo.jpeg", "scan.gif",
    "render.webp", "notes.txt", "export.csv",
    "quote.docx", "sheet.xlsx", "drawing.dxf", "drawing.dwg",
  ];
  for (const name of allowed) {
    assert.equal(blockedUploadExtension(name), null, name);
  }
});

test("names that merely resemble a blocked extension are allowed", () => {
  // Substring matches would have failed every one of these.
  for (const name of [
    "phone-mount.stl",      // "ph"
    "graphene-jig.3mf",     // contains "phe"
    "jspline-tool.stl",     // starts "jsp"
    "photo.jpg",            // "pho"
    "alpha.stl",            // "pha"
    "phillips-head.step",   // "phi"
    "app.js",               // .js is not .jsp
    "styles.jsx",           // .jsx is not .jspx
    "data.json",
  ]) {
    assert.equal(blockedUploadExtension(name), null, name);
  }
});

test("a file with no extension at all is allowed", () => {
  assert.equal(blockedUploadExtension("README"), null);
  assert.equal(blockedUploadExtension(""), null);
  assert.equal(blockedUploadExtension("   "), null);
});

test("a version-numbered name is not mistaken for an extension", () => {
  assert.equal(blockedUploadExtension("bracket.v3.stl"), null);
  assert.equal(blockedUploadExtension("rev.1.2.3.step"), null);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test("the exported list covers both families and nothing this app takes", () => {
  assert.ok(BLOCKED_UPLOAD_EXTENSION_LIST.includes(".php"));
  assert.ok(BLOCKED_UPLOAD_EXTENSION_LIST.includes(".jsp"));
  const printing = [
    ".stl", ".3mf", ".obj", ".step", ".stp", ".gcode", ".gco", ".g",
    ".bgcode", ".gx", ".ctb", ".zip", ".pdf", ".png", ".jpg", ".jpeg",
    ".gif", ".webp", ".txt", ".csv",
  ];
  for (const ext of printing) {
    assert.ok(!BLOCKED_UPLOAD_EXTENSION_LIST.includes(ext), `${ext} must stay uploadable`);
  }
});

test("renderable markup is blocked — SVG and the HTML family", () => {
  // SVG is the one this was added for: served as image/svg+xml it is a
  // document, and a document served same-origin with the SPA can read the
  // session out of localStorage. See the header note in upload-file-types.ts.
  for (const name of [
    "logo.svg", "logo.svgz",
    "page.html", "page.htm", "page.xhtml", "page.xht",
    "page.shtml", "page.mhtml", "page.mht",
  ]) {
    assert.notEqual(blockedUploadExtension(name), null, name);
  }
});

test("the SVG block survives the same decoys the PHP block does", () => {
  // Same parser-confusion tricks the PHP family is tested against, because a
  // gate that stops "logo.svg" but not "logo.svg " is not a gate.
  assert.equal(blockedUploadExtension("logo.SVG"), ".svg");
  assert.equal(blockedUploadExtension("logo.svg "), ".svg");
  assert.equal(blockedUploadExtension("logo.svg."), ".svg");
  assert.equal(blockedUploadExtension("logo.svg\u0000.png"), ".svg");
  assert.equal(blockedUploadExtension("logo.svg.png"), ".svg");
  assert.equal(blockedUploadExtension("C:\\Users\\a\\logo.svg"), ".svg");
});

test("names that merely resemble the markup extensions are allowed", () => {
  for (const name of [
    "svg-holder.stl",   // no dot before svg
    "part.svgx",        // not .svg
    "bracket.html5.stl" // interior segment is "html5", not "html"
  ]) {
    assert.equal(blockedUploadExtension(name), null, name);
  }
});

test("the refusal message names the extension that was refused", () => {
  assert.match(blockedUploadMessage(".php"), /^\.php files are not accepted\./);
});

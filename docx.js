/* Minimal, dependency-free OOXML writer. Exports editable content, not HTML renamed as DOCX. */
var ReadingNotesDocx = {
  xml(value) {
    return String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  },

  color(value) {
    value = String(value || "").trim().toLowerCase();
    const names = {red:"ff0000", blue:"0000ff", green:"008000", black:"000000", white:"ffffff", yellow:"ffff00", gray:"808080", orange:"ffa500", purple:"800080"};
    value = names[value] || value;
    let channels, alpha = 1;
    const hex = value.match(/^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
    if (hex) {
      let code = hex[1];
      if (code.length < 5) code = [...code].map(c => c + c).join("");
      channels = [0,2,4].map(i => parseInt(code.slice(i,i+2),16));
      if (code.length === 8) alpha = parseInt(code.slice(6),16)/255;
    } else {
      const rgb = value.match(/^rgba?\(([^)]+)\)$/);
      if (!rgb) return null;
      const parts = rgb[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      channels = parts.slice(0,3).map(c => c.endsWith("%") ? parseFloat(c)*2.55 : Number(c));
      if (parts[3]) alpha = parts[3].endsWith("%") ? parseFloat(parts[3])/100 : Number(parts[3]);
    }
    if (![...channels,alpha].every(Number.isFinite)) return null;
    alpha = Math.max(0,Math.min(1,alpha));
    return channels.map(c => Math.round(Math.max(0,Math.min(255,c))*alpha + 255*(1-alpha)).toString(16).padStart(2,"0")).join("").toUpperCase();
  },

  inlineStyle(node, inherited = {}) {
    const next = {...inherited};
    const tag = node.localName?.toLowerCase();
    if (node.hasAttribute("data-annotation")) next.excerpt = true;
    if (["b","strong"].includes(tag)) next.bold = true;
    if (["i","em"].includes(tag)) next.italic = true;
    if (tag === "u") next.underline = true;
    if (["s","del","strike"].includes(tag)) next.strike = true;
    if (["code","pre","tt","kbd","samp"].includes(tag)) next.font = "Consolas";
    const css = node.style;
    const color = this.color(css?.color || node.getAttribute("color"));
    const background = this.color(css?.backgroundColor || css?.background);
    if (color) next.color = color;
    if (background) next.background = background;
    const font = css?.fontFamily || node.getAttribute("face");
    if (font) next.font = font.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
    if (css?.fontWeight) next.bold = css.fontWeight === "bold" || Number(css.fontWeight) >= 600;
    if (css?.fontStyle) next.italic = /italic|oblique/.test(css.fontStyle);
    const decoration = css?.textDecoration || css?.textDecorationLine;
    if (decoration) { next.underline = decoration.includes("underline"); next.strike = decoration.includes("line-through"); }
    const size = css?.fontSize?.match(/^([\d.]+)(px|pt)$/);
    if (size) next.size = Math.round(Number(size[1]) * (size[2] === "px" ? 1.5 : 2));
    return next;
  },

  async fromHTML(html, resolveImage, appearance = {}) {
    const settings = { ownFont: "Microsoft YaHei", excerptFont: "SimSun", fontSize: 14,
      lineHeight: 1.3, paragraphBefore: 0, paragraphAfter: 2, italic: true, bold: false, ...appearance };
    const doc = new DOMParser().parseFromString('<!doctype html><html><head></head><body>' + html + '</body></html>', "text/html");
    for (const node of doc.querySelectorAll(".citation[data-citation],script,style")) node.remove();
    const media = [];
    const relationships = [];
    const x = value => this.xml(value);
    const run = (text, style = {}) => {
      const font = style.font || (style.excerpt ? settings.excerptFont : null);
      const props = (font ? `<w:rFonts w:ascii="${x(font)}" w:hAnsi="${x(font)}" w:eastAsia="${x(font)}"/>` : "")
        + ((style.bold ?? (style.excerpt && settings.bold)) ? "<w:b/>" : "")
        + ((style.italic ?? (style.excerpt && settings.italic)) ? "<w:i/>" : "")
        + (style.strike ? "<w:strike/>" : "")
        + (style.underline ? '<w:u w:val="single"/>' : "")
        + (style.color ? `<w:color w:val="${style.color}"/>` : "")
        + (style.background ? `<w:shd w:val="clear" w:fill="${style.background}"/>` : "")
        + (style.size ? `<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>` : "");
      return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
    };
    const imageRun = async node => {
      let bytes;
      const key = node.getAttribute("data-attachment-key");
      if (key) bytes = await resolveImage(key);
      else {
        const source = node.getAttribute("src") || "";
        const match = source.match(/^data:image\/(?:png|jpeg|jpg|gif);base64,([A-Za-z0-9+/=\s]+)$/);
        if (!match) throw new Error("有一张图片无法嵌入 Word，请先将图片保存到 Zotero 笔记中。");
        bytes = Uint8Array.from(atob(match[1].replace(/\s/g, "")), c => c.charCodeAt(0));
      }
      const info = this.imageInfo(bytes);
      const index = media.length + 1;
      const name = `image${index}.${info.extension}`;
      const relation = `rIdImage${index}`;
      media.push({ name, bytes, type: info.mime });
      relationships.push(`<Relationship Id="${relation}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
      let width = Number(node.getAttribute("width")) || info.width || 420;
      let height = Number(node.getAttribute("height")) || width * (info.height / info.width || 0.75);
      if (width > 600) { height *= 600 / width; width = 600; }
      if (height > 850) { width *= 850 / height; height = 850; }
      const cx = Math.max(1, Math.round(width * 9525)), cy = Math.max(1, Math.round(height * 9525));
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${index}" name="${name}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relation}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    };
    const inline = async (node, style = {}) => {
      if (node.nodeType === 3) return run(node.nodeValue, style);
      if (node.nodeType !== 1) return "";
      const tag = node.localName.toLowerCase();
      if (tag === "br") return "<w:r><w:br/></w:r>";
      if (tag === "img") return imageRun(node);
      const next = this.inlineStyle(node, style);
      // Links become ordinary text: no PDF jump targets or Word hyperlink relationships.
      let value = "";
      for (const child of node.childNodes) value += await inline(child, next);
      return value;
    };
    const paragraph = async (node, options = {}) => {
      let props = /^h[1-6]$/.test(node.localName) ? `<w:pStyle w:val="Heading${node.localName[1]}"/>` : "";
      props += `<w:spacing w:before="${Math.round(settings.paragraphBefore * 15)}" w:after="${Math.round(settings.paragraphAfter * 15)}" w:line="${Math.round(settings.lineHeight * 240)}" w:lineRule="auto"/>`;
      const align = node.style?.textAlign;
      if (["left", "right", "center", "justify"].includes(align)) props += `<w:jc w:val="${align === "justify" ? "both" : align}"/>`;
      let contents = options.prefix ? run(options.prefix) : "";
      for (const child of node.childNodes) contents += await inline(child, this.inlineStyle(node, { excerpt: !!options.quote }));
      return `<w:p><w:pPr>${props}</w:pPr>${contents}</w:p>`;
    };
    const blocks = async (parent, options = {}) => {
      let result = "", pending = [];
      const flush = async () => {
        if (!pending.length) return;
        const p = doc.createElement("p");
        for (const child of pending) p.append(child.cloneNode(true));
        result += await paragraph(p, options);
        pending = [];
      };
      for (const node of parent.childNodes) {
        if (node.nodeType === 3 && !node.nodeValue.trim()) continue;
        const tag = node.localName?.toLowerCase();
        if (["div", "section", "article", "blockquote"].includes(tag)) {
          await flush();
          result += await blocks(node, { ...options, quote: options.quote || tag === "blockquote" });
        } else if (tag === "ul" || tag === "ol") {
          await flush();
          let number = Number(node.getAttribute("start")) || 1;
          for (const li of node.children) {
            const prefix = tag === "ol" ? `${number++}. ` : "• ";
            const p = doc.createElement("p");
            for (const child of li.childNodes) if (!["ul", "ol"].includes(child.localName)) p.append(child.cloneNode(true));
            result += await paragraph(p, { ...options, prefix });
            for (const nested of li.children) if (["ul", "ol"].includes(nested.localName)) {
              const container = doc.createElement("div"); container.append(nested.cloneNode(true));
              result += await blocks(container, options);
            }
          }
        } else if (tag === "table") {
          await flush();
          let rows = "";
          for (const row of node.querySelectorAll("tr")) {
            let cells = "";
            for (const cell of row.children) {
              const colspan = Math.max(1, parseInt(cell.getAttribute("colspan")) || 1);
              cells += `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${colspan > 1 ? `<w:gridSpan w:val="${colspan}"/>` : ""}</w:tcPr>${await blocks(cell, options) || "<w:p/>"}<w:p/></w:tc>`;
            }
            rows += `<w:tr>${cells}</w:tr>`;
          }
          result += `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${rows}</w:tbl>`;
        } else if (tag === "p" || /^h[1-6]$/.test(tag || "") || tag === "pre") {
          await flush(); result += await paragraph(node, options);
        } else if (tag === "hr") { await flush(); result += "<w:p/>"; }
        else pending.push(node);
      }
      await flush();
      return result;
    };
    const body = await blocks(doc.body);
    return this.package(body, media, relationships, settings);
  },

  imageInfo(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47) {
      return { extension: "png", mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (bytes.length >= 10 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) {
      return { extension: "gif", mime: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
      let i = 2;
      while (i + 8 < bytes.length) {
        if (bytes[i] !== 255) { i++; continue; }
        const marker = bytes[i + 1];
        if (marker === 0xda || marker === 0xd9) break;
        const size = view.getUint16(i + 2);
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          return { extension: "jpg", mime: "image/jpeg", width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
        }
        if (size < 2) break;
        i += 2 + size;
      }
      return { extension: "jpg", mime: "image/jpeg", width: 420, height: 315 };
    }
    throw new Error("Word 导出暂支持 PNG、JPEG 和 GIF 图片；请将其他格式转换后再导出。");
  },

  package(body, media, relationships, settings) {
    const xml = text => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + text;
    const files = {
      "[Content_Types].xml": xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        + [...new Map(media.map(image => [image.name.split(".").pop(), image.type]))].map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join("")
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
      "_rels/.rels": xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      "word/document.xml": xml('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>'),
      "word/_rels/document.xml.rels": xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' + relationships.join("") + '</Relationships>'),
      "word/styles.xml": xml(`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${this.xml(settings.ownFont)}" w:hAnsi="${this.xml(settings.ownFont)}" w:eastAsia="${this.xml(settings.ownFont)}"/><w:sz w:val="${Math.round(settings.fontSize * 1.5)}"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`
        + Array.from({ length: 6 }, (_, i) => `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${32 - i * 2}"/></w:rPr></w:style>`).join("") + '</w:styles>')
    };
    for (const image of media) files["word/media/" + image.name] = image.bytes;
    return this.zip(files);
  },

  zip(files) {
    const encoder = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0, count = 0;
    const header = (length, signature) => {
      const bytes = new Uint8Array(length); new DataView(bytes.buffer).setUint32(0, signature, true); return bytes;
    };
    const crc32 = bytes => {
      let value = 0xffffffff;
      for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
      return (value ^ 0xffffffff) >>> 0;
    };
    for (const [path, value] of Object.entries(files)) {
      const name = encoder.encode(path), bytes = typeof value === "string" ? encoder.encode(value) : value;
      const crc = crc32(bytes);
      const local = header(30, 0x04034b50), l = new DataView(local.buffer);
      l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(12, 0x21, true);
      l.setUint32(14, crc, true); l.setUint32(18, bytes.length, true); l.setUint32(22, bytes.length, true); l.setUint16(26, name.length, true);
      chunks.push(local, name, bytes);
      const entry = header(46, 0x02014b50), c = new DataView(entry.buffer);
      c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 0x21, true);
      c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(entry, name); offset += local.length + name.length + bytes.length; count++;
    }
    const centralLength = central.reduce((sum, bytes) => sum + bytes.length, 0);
    const end = header(22, 0x06054b50), e = new DataView(end.buffer);
    e.setUint16(8, count, true); e.setUint16(10, count, true); e.setUint32(12, centralLength, true); e.setUint32(16, offset, true);
    const output = new Uint8Array(offset + centralLength + end.length);
    let position = 0;
    for (const chunk of [...chunks, ...central, end]) { output.set(chunk, position); position += chunk.length; }
    return output;
  }
};

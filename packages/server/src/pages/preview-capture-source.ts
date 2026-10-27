import {
  PREVIEW_CAPTURE_MAX_BYTES,
  PREVIEW_CAPTURE_MAX_HEIGHT,
  PREVIEW_CAPTURE_MAX_WIDTH
} from "@work-shape/catalyst-core";

// The picture of a Page a run asks for (PREVIEW-SEE-1), taken in the browser that shows it.
// The guard of every Page document calls this with the Page's window and the interface's
// window, before the Page is written. It answers one message only: `capture` with a request id
// from the interface's window. It then draws the document as the person sees it into a canvas,
// through an SVG `foreignObject` that holds a copy of the document with its computed styles
// written into each element, and posts the canvas as WebP bytes back to the interface.
//
// An SVG image loads nothing, so images and backgrounds are loaded again with `crossOrigin`
// (the content route answers every origin) and written in as data addresses, and a canvas,
// such as a chart, is copied as it is drawn. Fonts the Page loaded are not, and fall back to a
// default font. A browser that taints a canvas that drew a `foreignObject`, as Safari does, or
// encodes no WebP, answers that it cannot take a picture.
//
// It runs in the Page's realm. A Page can change what it shows or answer itself, and so can
// only spoil a picture of itself: the interface and the instance check the answer's shape and
// bounds. Nothing here throws into the Page, and nothing runs until the interface asks.
export const PREVIEW_CAPTURE_SOURCE = `function (win, host) {
  "use strict";
  var MAX_WIDTH = ${PREVIEW_CAPTURE_MAX_WIDTH};
  var MAX_HEIGHT = ${PREVIEW_CAPTURE_MAX_HEIGHT};
  var MAX_BYTES = ${PREVIEW_CAPTURE_MAX_BYTES};
  var IMAGE_MS = 3000;
  var IMAGE_MAX_PX = 2048;
  var MAX_NODES = 6000;
  var QUALITIES = [0.85, 0.7, 0.55, 0.4];
  var XHTML = "http://www.w3.org/1999/xhtml";
  var SVG = "http://www.w3.org/2000/svg";
  var apply = win.Reflect.apply;
  var listen = win.EventTarget.prototype.addEventListener;
  var describe = win.Object.getOwnPropertyDescriptor;
  var sourceOf = describe(win.MessageEvent.prototype, "source").get;
  var dataOf = describe(win.MessageEvent.prototype, "data").get;
  var doc = win.document;
  var computed = win.getComputedStyle;
  var SKIP = {
    script: 1, noscript: 1, style: 1, link: 1, meta: 1, template: 1, head: 1, title: 1,
    iframe: 1, frame: 1, object: 1, embed: 1, base: 1
  };
  var REPLACED = { img: 1, canvas: 1, video: 1, svg: 1, input: 1, textarea: 1, select: 1, button: 1 };
  // Moving parts and what only matters to a pointer: a copy that animated again would be drawn
  // at its first frame.
  var IGNORED = /^(animation|transition|will-change|cursor|pointer-events|user-select|-webkit-user-select|d$|content$)/;
  var INHERITED = {};
  var inheritedNames = (
    "color,font,font-family,font-size,font-style,font-weight,font-stretch,font-variant," +
    "font-variant-caps,font-variant-ligatures,font-variant-numeric,font-variant-east-asian," +
    "font-feature-settings,font-variation-settings,font-kerning,font-optical-sizing,font-size-adjust," +
    "font-synthesis,line-height,letter-spacing,word-spacing,text-align,text-align-last,text-indent," +
    "text-transform,text-shadow,text-rendering,white-space,white-space-collapse,text-wrap," +
    "text-wrap-mode,word-break,overflow-wrap,word-wrap,hyphens,tab-size,direction,writing-mode," +
    "visibility,list-style,list-style-type,list-style-position,list-style-image,border-collapse," +
    "border-spacing,caption-side,empty-cells,quotes,orphans,widows,line-break," +
    "-webkit-text-fill-color,-webkit-text-stroke-color,-webkit-text-stroke-width," +
    "-webkit-font-smoothing,-moz-osx-font-smoothing,fill,fill-opacity,fill-rule,stroke," +
    "stroke-width,stroke-opacity,stroke-linecap,stroke-linejoin,stroke-dasharray," +
    "stroke-dashoffset,stroke-miterlimit,paint-order,text-anchor,dominant-baseline," +
    "color-scheme,accent-color,caret-color,image-rendering,text-underline-position," +
    "text-underline-offset,text-decoration-skip-ink,-webkit-locale"
  ).split(",");
  for (var at = 0; at < inheritedNames.length; at += 1) {
    INHERITED[inheritedNames[at]] = 1;
  }
  var busy = false;

  function answer(requestId, picture) {
    var message = picture
      ? { catalystBridge: 1, type: "capture_result", requestId: requestId, image: picture.bytes,
          width: picture.width, height: picture.height }
      : { catalystBridge: 1, type: "capture_result", requestId: requestId, unavailable: true };
    try {
      host.postMessage(message, "*", picture ? [picture.bytes] : []);
    } catch (error) {}
  }

  apply(listen, win, ["message", function (event) {
    try {
      if (apply(sourceOf, event, []) !== host) {
        return;
      }
      var data = apply(dataOf, event, []);
      if (!data || data.catalystBridge !== 1 || data.type !== "capture" ||
          typeof data.requestId !== "string") {
        return;
      }
      var requestId = data.requestId;
      if (busy) {
        answer(requestId, null);
        return;
      }
      busy = true;
      take().then(function (picture) {
        busy = false;
        answer(requestId, picture);
      }, function () {
        busy = false;
        answer(requestId, null);
      });
    } catch (error) {
      busy = false;
    }
  }]);

  function take() {
    return new Promise(function (resolve, reject) {
      var root = doc.documentElement;
      var body = doc.body;
      if (!root || !body) {
        reject(new Error("empty"));
        return;
      }
      var width = root.clientWidth || win.innerWidth;
      if (!(width > 0)) {
        reject(new Error("empty"));
        return;
      }
      var scale = width > MAX_WIDTH ? MAX_WIDTH / width : 1;
      var top = win.scrollY || 0;
      var full = Math.max(root.scrollHeight, body.scrollHeight, win.innerHeight || 0);
      var height = Math.max(1, Math.min(full - top, Math.floor(MAX_HEIGHT / scale)));
      var copied = copyDocument(root, width, full, top);
      copied.then(function (svg) {
        var image = new win.Image();
        image.onload = function () {
          encode(image, Math.max(1, Math.min(MAX_WIDTH, Math.round(width * scale))),
            Math.max(1, Math.min(MAX_HEIGHT, Math.round(height * scale))), 0, 0, resolve, reject);
        };
        image.onerror = function () {
          reject(new Error("draw"));
        };
        image.src = "data:image/svg+xml;charset=utf-8," +
          encodeURIComponent(svg(width, height));
      }, reject);
    });
  }

  // Draws the image at the size asked and encodes it, smaller each time it is too large.
  function encode(image, width, height, step, shrunk, resolve, reject) {
    var canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    // A tainted canvas throws here, as in Safari: no picture.
    canvas.toBlob(function (blob) {
      if (!blob || blob.type !== "image/webp") {
        reject(new Error("webp"));
        return;
      }
      if (blob.size <= MAX_BYTES) {
        blob.arrayBuffer().then(function (bytes) {
          resolve({ bytes: bytes, width: width, height: height });
        }, reject);
        return;
      }
      if (step + 1 < QUALITIES.length) {
        encode(image, width, height, step + 1, shrunk, resolve, reject);
      } else if (shrunk < 3) {
        encode(image, Math.max(1, Math.round(width * 0.75)), Math.max(1, Math.round(height * 0.75)),
          1, shrunk + 1, resolve, reject);
      } else {
        reject(new Error("size"));
      }
    }, "image/webp", QUALITIES[step]);
  }

  // A copy of the document, every element with the styles it is drawn with, and a function
  // that writes it into an SVG image of the region shown.
  function copyDocument(root, width, full, top) {
    var sandbox = doc.createElement("div");
    sandbox.setAttribute("style", "all:initial;position:absolute;left:-100000px;top:0;visibility:hidden");
    var sandboxSvg = doc.createElementNS(SVG, "svg");
    sandbox.appendChild(sandboxSvg);
    root.appendChild(sandbox);
    var defaults = {};
    var waits = [];
    var images = {};
    var pseudoRules = [];
    var count = 0;

    function defaultsOf(inSvg, tag) {
      var key = (inSvg ? "svg " : "html ") + tag;
      if (defaults[key]) {
        return defaults[key];
      }
      var values = {};
      try {
        var element = inSvg ? doc.createElementNS(SVG, tag) : doc.createElement(tag);
        (inSvg ? sandboxSvg : sandbox).appendChild(element);
        var style = computed(element);
        for (var index = 0; index < style.length; index += 1) {
          values[style[index]] = style.getPropertyValue(style[index]);
        }
        element.remove();
      } catch (error) {}
      defaults[key] = values;
      return values;
    }

    function dataAddress(address, size) {
      if (/^data:/i.test(address)) {
        return Promise.resolve(address);
      }
      var key = address + " " + (size ? size.width + "x" + size.height : "");
      if (!images[key]) {
        images[key] = new Promise(function (done) {
          var image = new win.Image();
          var timer = win.setTimeout(function () {
            done(null);
          }, IMAGE_MS);
          image.crossOrigin = "anonymous";
          image.onload = function () {
            win.clearTimeout(timer);
            try {
              var w = (size && size.width) || image.naturalWidth || 300;
              var h = (size && size.height) || image.naturalHeight || 150;
              var fit = Math.min(1, IMAGE_MAX_PX / Math.max(w, h));
              var canvas = doc.createElement("canvas");
              canvas.width = Math.max(1, Math.round(w * fit));
              canvas.height = Math.max(1, Math.round(h * fit));
              canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
              done(canvas.toDataURL("image/webp", 0.9));
            } catch (error) {
              done(null);
            }
          };
          image.onerror = function () {
            win.clearTimeout(timer);
            done(null);
          };
          image.src = address;
        });
      }
      return images[key];
    }

    function styleText(style, inSvg, tag, parentValues, always) {
      var base = defaultsOf(inSvg, tag);
      var values = {};
      var text = "";
      for (var index = 0; index < style.length; index += 1) {
        var name = style[index];
        var value = style.getPropertyValue(name);
        values[name] = value;
        if (IGNORED.test(name)) {
          continue;
        }
        if (value !== base[name] || always[name] ||
            (INHERITED[name] && parentValues && value !== parentValues[name])) {
          text += name + ":" + value + ";";
        }
      }
      return { text: text, values: values };
    }

    function pseudo(node, clone, which) {
      var style = computed(node, which);
      var content = style.getPropertyValue("content");
      if (!content || content === "none" || content === "normal") {
        return;
      }
      var name = "catalyst-capture-" + pseudoRules.length;
      var base = defaultsOf(false, "span");
      var text = "content:" + content + ";";
      for (var index = 0; index < style.length; index += 1) {
        var property = style[index];
        var value = style.getPropertyValue(property);
        if (!IGNORED.test(property) && value !== base[property]) {
          text += property + ":" + value + ";";
        }
      }
      pseudoRules.push("." + name + which + "{" + text + "}");
      var classes = clone.getAttribute("class");
      clone.setAttribute("class", (classes ? classes + " " : "") + name);
    }

    function copy(node, parentValues) {
      count += 1;
      if (count > MAX_NODES) {
        return null;
      }
      if (node.nodeType === 3) {
        return doc.createTextNode(node.data);
      }
      if (node.nodeType !== 1) {
        return null;
      }
      var tag = node.localName;
      var inSvg = node instanceof win.SVGElement;
      if (SKIP[tag] || node === sandbox) {
        return null;
      }
      var style = computed(node);
      if (style.getPropertyValue("display") === "none") {
        return null;
      }
      var always = REPLACED[tag] ? { width: 1, height: 1 } : {};
      var written = styleText(style, inSvg, tag, parentValues, always);
      var clone;
      if (tag === "canvas" || tag === "video") {
        clone = doc.createElement("img");
        try {
          var drawn = node;
          if (tag === "video") {
            drawn = doc.createElement("canvas");
            drawn.width = node.videoWidth || 1;
            drawn.height = node.videoHeight || 1;
            drawn.getContext("2d").drawImage(node, 0, 0);
          }
          clone.setAttribute("src", drawn.toDataURL("image/png"));
        } catch (error) {}
      } else {
        clone = node.cloneNode(false);
      }
      clone.removeAttribute("style");
      if (tag === "img") {
        clone.removeAttribute("srcset");
        clone.removeAttribute("loading");
        var address = node.currentSrc || node.src;
        clone.removeAttribute("src");
        if (address) {
          waits.push(dataAddress(address, {
            width: Math.ceil(node.clientWidth * 2) || node.naturalWidth,
            height: Math.ceil(node.clientHeight * 2) || node.naturalHeight
          }).then(function (data) {
            if (data) {
              clone.setAttribute("src", data);
            }
          }));
        }
      } else if (tag === "input") {
        if (node.type === "checkbox" || node.type === "radio") {
          if (node.checked) {
            clone.setAttribute("checked", "");
          } else {
            clone.removeAttribute("checked");
          }
        } else if (node.type !== "password" && node.type !== "file") {
          clone.setAttribute("value", node.value);
        }
      } else if (tag === "option") {
        if (node.selected) {
          clone.setAttribute("selected", "");
        } else {
          clone.removeAttribute("selected");
        }
      }
      var text = written.text;
      var background = style.getPropertyValue("background-image");
      if (background && background.indexOf("url(") >= 0) {
        var pattern = /url\\("([^"]*)"\\)/g;
        var found = [];
        var match;
        while ((match = pattern.exec(background))) {
          found.push(match[1]);
        }
        waits.push(Promise.all(found.map(function (address) {
          return dataAddress(address, null);
        })).then(function (datas) {
          var replaced = background;
          for (var index = 0; index < found.length; index += 1) {
            replaced = replaced.split(found[index]).join(datas[index] || "");
          }
          var current = clone.getAttribute("style") || "";
          clone.setAttribute("style", current + "background-image:" + replaced + ";");
        }));
      }
      clone.setAttribute("style", text);
      if (!inSvg) {
        pseudo(node, clone, "::before");
        pseudo(node, clone, "::after");
      }
      if (tag === "textarea") {
        clone.textContent = node.value;
        return clone;
      }
      if (tag === "canvas" || tag === "video") {
        return clone;
      }
      var children = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
      var shiftX = node.scrollLeft || 0;
      var shiftY = node.scrollTop || 0;
      var shifted = node !== root && node !== doc.body && (shiftX > 0 || shiftY > 0);
      for (var index = 0; index < children.length; index += 1) {
        var child = copy(children[index], written.values);
        if (!child) {
          continue;
        }
        // What a scrolled box shows: its children moved by what it scrolled.
        if (shifted && child.nodeType === 1) {
          child.setAttribute("style", (child.getAttribute("style") || "") +
            "translate:" + -shiftX + "px " + -shiftY + "px;");
        }
        clone.appendChild(child);
      }
      return clone;
    }

    function asDiv(clone) {
      var div = doc.createElementNS(XHTML, "div");
      for (var index = 0; index < clone.attributes.length; index += 1) {
        var attribute = clone.attributes[index];
        div.setAttribute(attribute.name, attribute.value);
      }
      while (clone.firstChild) {
        div.appendChild(clone.firstChild);
      }
      return div;
    }

    var page;
    try {
      page = copy(root, null);
    } finally {
      sandbox.remove();
    }
    if (!page) {
      return Promise.reject(new Error("empty"));
    }
    var outer = asDiv(page);
    for (var child = outer.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && child.localName === "body") {
        outer.replaceChild(asDiv(child), child);
        break;
      }
    }
    outer.setAttribute("style", (outer.getAttribute("style") || "") +
      "width:" + width + "px;height:" + full + "px;margin:0;translate:0 " + -top + "px;");
    if (pseudoRules.length > 0) {
      var rules = doc.createElementNS(XHTML, "style");
      rules.textContent = pseudoRules.join("\\n");
      outer.insertBefore(rules, outer.firstChild);
    }
    return Promise.all(waits).then(function () {
      var xml = new win.XMLSerializer().serializeToString(outer);
      return function (w, h) {
        return '<svg xmlns="' + SVG + '" width="' + w + '" height="' + h + '">' +
          '<foreignObject x="0" y="0" width="100%" height="100%">' + xml + "</foreignObject></svg>";
      };
    });
  }
}`;

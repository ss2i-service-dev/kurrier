// Keyboard shortcut layer for kurrier - ABSENT from the official build.
//
// Finding: no `useHotkeys`, no key combination declared in the bundle. The
// "⌘K" shown in the search bar is a decorative label.
//
// DESIGN CHOICE. React internals are left alone: this module drives the buttons
// that are already rendered, finding them by their visible label. This is
// deliberately naive, and that is what makes it robust: it is insensitive to
// minification, variable names and version upgrades. If a button disappears, the
// shortcut becomes inert instead of breaking the page.
//
// Served from /public and loaded by the root layout (next/script).

(() => {
  if (typeof window === "undefined" || window.__kurrierShortcuts) return;
  window.__kurrierShortcuts = true;

  // A single set of shortcuts. The default keys below are used until the page has
  // passed on the user's own (Settings > Keyboard shortcuts,
  // components/k/shortcuts-config.tsx -> window.__kurrierShortcutsConfig).
  // Keys are written as in components/k/shortcuts-catalog.ts.
  const SHORTCUTS = [
    ["compose", ["c"], "New message", () => click("Compose")],
    ["reply", ["r"], "Reply", () => click("Reply")],
    ["forward", ["f"], "Forward", () => click("Forward")],
    ["archive", ["a"], "Archive (open or selected mail)", () => onMailOrSelection("Archive")],
    ["delete", ["e", "#"], "Delete (open or selected mail)", () => onMailOrSelection("Delete")],
    ["unread", ["u"], "Mark as unread and return to the list", () => markUnread()],
    ["search", ["/"], "Search", () => focusSearch()],
    ["help", ["?"], "Show shortcuts", () => toggleHelp()],
    // Modern interface only: list navigation and closing the open thread.
    ["next", ["j", "ArrowDown"], "Next conversation", () => modern() && neighbour(1), "list"],
    ["prev", ["k", "ArrowUp"], "Previous conversation", () => modern() && neighbour(-1), "list"],
    ["close", ["Escape"], "Close the conversation", () => closeThread()],
    // Never from a dialog without an editor (e.g. an instruction prompt): the Send
    // button found would belong to a draft open behind it, sent blindly.
    ["send", ["Ctrl+Enter"], "Send the message", () => !inDialogWithoutEditor() && click("Send")],
  ];

  const config = () => window.__kurrierShortcutsConfig || null;
  const keysOf = (id, fallback) => {
    const c = config();
    const t = c && c.bindings && c.bindings[id];
    return Array.isArray(t) ? t : fallback;
  };

  // Same normalisation as comboFromEvent (components/k/shortcuts-catalog.ts).
  const combination = (e) => {
    let key = e.key;
    if (!key || ["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock", "Dead", "Unidentified"].includes(key)) return null;
    if (key === " ") key = "Space";
    const altGr = typeof e.getModifierState === "function" && e.getModifierState("AltGraph");
    const single = key.length === 1;
    const letter = single && /\p{L}/u.test(key);
    const mods = [];
    if (!(single && !letter && altGr)) {
      if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
    }
    if (e.shiftKey && (!single || letter)) mods.push("Shift");
    if (letter) key = key.toLowerCase();
    return [...mods, key].join("+");
  };
  const hasModifier = (combo) => combo.split("+").slice(0, -1).some((m) => m === "Ctrl" || m === "Alt");

  // Finds a button by its visible label, exactly then as a partial fallback.
  // Modern interface (<html data-ui="k">): its buttons carry data-k-action, so
  // they are looked up that way first. The classic interface has no such
  // attributes: nothing changes for it.
  const modern = () => document.documentElement.dataset.ui === "k";
  const ACTIONS_K = { Compose: "compose", Reply: "reply", Forward: "forward", Archive: "archive", Delete: "delete", Send: "send" };
  const visible = (el) => el && el.offsetParent !== null;
  const clickK = (action) => {
    const target = Array.from(document.querySelectorAll(`[data-k-action="${action}"]`)).filter(visible).pop();
    if (target) target.click();
    return Boolean(target);
  };

  // Modern interface: next / previous thread of the list (arrows, j, k).
  const neighbour = (step) => {
    const rows = Array.from(document.querySelectorAll("li[data-thread-id]")).filter(visible);
    if (!rows.length) return false;
    const i = rows.findIndex((l) => l.getAttribute("aria-current") === "true");
    const target = rows[i < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, i + step))];
    target.click();
    target.scrollIntoView({ block: "nearest" });
    return true;
  };

  const click = (label) => {
    if (modern() && ACTIONS_K[label] && clickK(ACTIONS_K[label])) return true;
    const buttons = Array.from(document.querySelectorAll("button, a[role=button]"));
    const target =
      buttons.find((b) => b.textContent.trim() === label) ||
      buttons.find((b) => b.textContent.trim().startsWith(label));
    if (target) target.click();
    return Boolean(target);
  };

  const inOpenMail = () => /\/threads\/[^/]+/.test(window.location.pathname);

  // In an open mail: the mail's labelled button. On the list: the button of the
  // selection bar, marked data-k-shortcut (mail-list-header.tsx) and visible
  // only if mails are checked; without a selection, nothing happens. Never by
  // title: each row of the list has its own "Delete" / "Archive" buttons.
  const onMailOrSelection = (label) => {
    if (inOpenMail()) return click(label);
    const mark = label === "Delete" ? "selection-delete" : "selection-archive";
    const target = Array.from(
      document.querySelectorAll(`button[data-k-shortcut="${mark}"]`)
    ).find((b) => b.offsetParent !== null);
    if (target) target.click();
    return Boolean(target);
  };

  // Unread: only in an open mail (URL .../threads/<id>). The button is an icon
  // without text, found by its aria-label; it marks the thread unread and
  // returns to the list (email-renderer.tsx, unreadMessage).
  const markUnread = () => {
    if (!inOpenMail()) return false;
    if (modern() && clickK("unread")) return true;
    const target = document.querySelector('button[aria-label="Mark as unread"]');
    if (target) target.click();
    return Boolean(target);
  };

  // Modern interface: closes the open thread (unless a dialog or menu is open).
  const closeThread = () => {
    if (!modern() || document.querySelector('[role="dialog"], [role="menu"]')) return false;
    return clickK("close");
  };

  const focusSearch = () => {
    if (modern() && clickK("search")) return true;
    const field = document.querySelector('input[placeholder^="Search this mailbox"]');
    if (field) field.focus();
    return Boolean(field);
  };

  const escapeHtml = (t) =>
    String(t).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

  // Users cannot adopt a shortcut they do not know about: "?" lists them.
  const toggleHelp = () => {
    const existing = document.getElementById("kurrier-shortcuts-help");
    if (existing) {
      existing.remove();
      return true;
    }
    const box = document.createElement("div");
    box.id = "kurrier-shortcuts-help";
    box.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(0,0,0,.55)";
    const c = config();
    const kbd = (keyName) =>
      (modern()
        ? `<kbd style="background:var(--k-hover);color:var(--k-ink);border:1px solid var(--k-line-strong);border-radius:5px;padding:.1rem .45rem;`
        : `<kbd style="background:#333;color:#fff;border-radius:4px;padding:.1rem .45rem;`) +
      `font-family:monospace;white-space:nowrap">${escapeHtml(keyName)}</kbd>`;
    // With the user's configuration: their keys, translated labels.
    // Without (before it has loaded): the default keys.
    const entries = c && Array.isArray(c.help)
      ? c.help.map((h) => [h.keys, h.label])
      : SHORTCUTS.filter(([, , , , scope]) => modern() || !scope)
          .filter(([id]) => modern() || id !== "close")
          .map(([, keys, label]) => [keys, label]);
    const rows = entries
      .map(
        ([keys, label]) =>
          `<tr><td style="padding:.35rem .9rem .35rem 0;text-align:right">` +
          keys.map(kbd).join(" ") +
          `</td><td style="padding:.35rem 0">${escapeHtml(label)}</td></tr>`
      )
      .join("");
    box.innerHTML =
      (modern()
        ? `<div style="background:var(--k-surface);color:var(--k-ink);border-radius:14px;padding:1.4rem 1.8rem;` +
          `font:13.5px var(--font-sans),system-ui;box-shadow:var(--k-shadow-pop);min-width:340px">`
        : `<div style="background:#1b1b1f;color:#eee;border-radius:12px;padding:1.5rem 2rem;` +
          `font:14px system-ui;box-shadow:0 10px 40px rgba(0,0,0,.5)">`) +
      `<div style="font-weight:600;margin-bottom:.9rem">${escapeHtml((c && c.texts && c.texts.title) || "Keyboard shortcuts")}</div>` +
      `<table>${rows}</table>` +
      `<div style="margin-top:1rem;opacity:.6;font-size:12px">` +
      `${escapeHtml((c && c.texts && c.texts.close) || "Esc or ? to close")}</div></div>`;
    box.addEventListener("click", () => box.remove());
    document.body.appendChild(box);
    return true;
  };

  // Never steal a keystroke meant for an input field.
  const inInput = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const t = el.tagName;
    // A checkbox is not an input: after checking mails, the focus stays on it
    // and "e" must act on the selection.
    if (t === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return false;
    return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
  };

  // ---------------------------------------------------------------------------
  // INPUT LOCK. While a mail is being written, no bare key must ever become a
  // shortcut, even if the focus has left the text area (editor redrawn by a
  // router.refresh, element removed from the DOM, click in a margin): while
  // typing, no keyboard shortcut is active except combinations with Ctrl or Alt.
  // Rule: as long as a mail editor is open,
  //  1. shortcuts without Ctrl / Alt / Meta are off, wherever the focus is;
  //  2. a keystroke that lands outside a field is handed back to the last input
  //     area (same caret position if the element still exists, otherwise end of
  //     the body);
  //  3. a focus lost "in the void" (body) without a user click is immediately
  //     handed back to the input area.
  // ---------------------------------------------------------------------------
  const EDITOR = '.ProseMirror[contenteditable="true"]';
  const openEditors = () => Array.from(document.querySelectorAll(EDITOR)).filter(visible);
  const composerOpen = () => openEditors().length > 0;
  let lastInput = null; // last input field that had the focus
  let lastSelection = null; // { el, range } inside a contenteditable
  let lastClick = 0;
  let lastTab = 0;

  const usable = (el) => el && el.isConnected && visible(el) && inInput(el);
  const inputTarget = () => {
    if (usable(lastInput)) return lastInput;
    const eds = openEditors();
    return eds.length ? eds[eds.length - 1] : null;
  };
  // Focus lost "in the void": body, html, or a non-interactive container.
  const focusInVoid = () => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return true;
    if (inInput(a)) return false;
    return !a.matches('button, a[href], select, summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"], [role="slider"], input');
  };
  // Focus in a dialog that has no mail editor (Ctrl+Enter sends nothing there).
  const inDialogWithoutEditor = () => {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('[role="dialog"]:not(:has(.ProseMirror))'));
  };
  // Menus, dropdowns, dialogs: the keyboard belongs to them.
  const inPopup = (el) =>
    !!(el && el.closest && el.closest('[role="menu"], [role="listbox"], [role="dialog"]:not(:has(.ProseMirror)), [role="tree"], [role="combobox"]'));

  const restoreFocus = () => {
    const target = inputTarget();
    if (!target) return false;
    target.focus({ preventScroll: true });
    // Caret put back where it was if the element is the same.
    if (lastSelection && lastSelection.el === target && target.isContentEditable) {
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(lastSelection.range);
      } catch (_) {
        /* range became invalid: keep the focus as is */
      }
    } else if (target.isContentEditable && !target.contains(window.getSelection()?.anchorNode || null)) {
      // New element (editor redrawn): caret at the end of the text.
      const r = document.createRange();
      r.selectNodeContents(target);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return document.activeElement === target;
  };

  window.addEventListener("pointerdown", () => (lastClick = Date.now()), true);
  window.addEventListener(
    "focusin",
    (e) => {
      if (inInput(e.target)) lastInput = e.target;
    },
    true
  );
  document.addEventListener("selectionchange", () => {
    const a = document.activeElement;
    if (!a || !a.isContentEditable) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && a.contains(sel.anchorNode)) {
      lastSelection = { el: a.closest('[contenteditable="true"]') || a, range: sel.getRangeAt(0).cloneRange() };
    }
  });
  window.addEventListener(
    "focusout",
    (e) => {
      if (!inInput(e.target)) return;
      // Let the browser set the new focus, then check where it landed.
      setTimeout(() => {
        if (!document.hasFocus()) return; // other window, other tab
        if (Date.now() - lastClick < 600) return; // the user clicked elsewhere
        if (Date.now() - lastTab < 600) return; // Tab: they are changing field
        if (!composerOpen() || !focusInVoid()) return;
        restoreFocus();
      }, 0);
    },
    true
  );

  // Capture phase on window, registered at load: runs before all the other
  // keyboard listeners of the page (React, dialogs, shortcuts below).
  window.addEventListener(
    "keydown",
    (e) => {
      try {
        if (e.key === "Tab") lastTab = Date.now();
        if (window.__kurrierShortcutsRecording) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return; // combinations: always allowed
        if (inInput(e.target)) return; // keystroke already in the right place
        if (!composerOpen() || inPopup(e.target)) return;
        const printable = e.key && e.key.length === 1;
        const editing = ["Backspace", "Delete", "Enter"].includes(e.key);
        // Space and Enter activate a button that has the focus (Tab to Send):
        // they are only diverted if the focus is in the void.
        if ((e.key === " " || e.key === "Enter") && !focusInVoid()) return;
        if (!printable && !editing && e.key !== "Escape") return; // arrows, F1...: nothing to steal
        // No listener sees this key as a shortcut any more.
        e.stopImmediatePropagation();
        if (e.key === "Escape") return;
        // The character goes to the field that receives the focus during keydown.
        if (!restoreFocus()) e.preventDefault();
      } catch (err) {
        console.error("input lock", err);
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      try {
        // A key is being recorded in the settings: do not react.
        if (window.__kurrierShortcutsRecording) return;
        // A mail is being written: no bare key is a shortcut.
        if (!hasModifier(combination(e) || "") && composerOpen()) return;
        const combo = combination(e);
        if (!combo) return;

        // The open help closes with Escape or its own key.
        const helpPanel = document.getElementById("kurrier-shortcuts-help");
        if (helpPanel && (combo === "Escape" || keysOf("help", ["?"]).includes(combo))) {
          helpPanel.remove();
          e.preventDefault();
          return;
        }

        const c = config();
        if (c && c.enabled === false) return;

        // Several actions can share a key (e.g. an action specific to the
        // modern interface): the first one that succeeds wins.
        const entries = SHORTCUTS.filter(([id, fallback]) => keysOf(id, fallback).includes(combo));
        for (const [, , , action, scope] of entries) {
          // Never steal a keystroke meant for an input field. A combination
          // with Ctrl or Alt (e.g. Ctrl+Enter to send) is expected precisely
          // from the editor, which is a contenteditable (Tiptap/ProseMirror).
          if (!hasModifier(combo) && inInput(e.target)) return;

          // List navigation: never inside a menu or a dialog.
          if (
            scope === "list" &&
            (e.target.closest?.('[role="menu"], [role="listbox"], [role="dialog"], [role="tree"]') ||
              document.querySelector('[role="dialog"][aria-modal="true"]'))
          )
            continue;

          if (action()) {
            e.preventDefault();
            return;
          }
        }
      } catch (err) {
        // A failing shortcut must never prevent typing.
        console.error("keyboard shortcuts", err);
      }
    },
    true
  );
})();

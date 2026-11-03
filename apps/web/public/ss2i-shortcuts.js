// Couche de raccourcis clavier pour kurrier — ABSENTE de la build officielle.
//
// Constat : aucun `useHotkeys`, aucune combinaison declaree dans le bundle. Le
// « ⌘K » affiche dans la barre de recherche est un libellé decoratif.
//
// PARTI PRIS. On ne touche pas aux internes React : ce module pilote les boutons
// deja rendus, en les retrouvant par leur libellé visible. C'est volontairement
// naif, et c'est ce qui le rend robuste — insensible a la minification, aux noms
// de variables et aux montees de version. Si un bouton disparait, le raccourci
// devient inerte au lieu de casser la page.
//
// Servi depuis /public et charge par le layout racine (next/script).

(() => {
  if (typeof window === "undefined" || window.__ss2iShortcuts) return;
  window.__ss2iShortcuts = true;

  // Un seul jeu de raccourcis. Les touches par defaut ci-dessous servent tant que
  // la page n'a pas transmis celles de l'utilisateur (Parametres > Raccourcis
  // clavier, components/k/shortcuts-config.tsx -> window.__ss2iShortcutsConfig).
  // Les touches s'ecrivent comme dans components/k/shortcuts-catalog.ts.
  const RACCOURCIS = [
    ["compose", ["c"], "Nouveau message", () => cliquer("Compose")],
    ["reply", ["r"], "Repondre", () => cliquer("Reply")],
    ["forward", ["f"], "Transferer", () => cliquer("Forward")],
    ["archive", ["a"], "Archiver (le mail ouvert ou les mails coches)", () => surMailOuSelection("Archive")],
    ["delete", ["e", "#"], "Supprimer (le mail ouvert ou les mails coches)", () => surMailOuSelection("Delete")],
    ["unread", ["u"], "Marquer non lu et revenir a la liste", () => marquerNonLu()],
    ["search", ["/"], "Rechercher", () => focaliserRecherche()],
    ["help", ["?"], "Afficher cette aide", () => basculerAide()],
    // Nouvelle interface seulement : navigation dans la liste et fermeture du fil.
    ["next", ["j", "ArrowDown"], "Fil suivant", () => nouvelle() && voisin(1), "liste"],
    ["prev", ["k", "ArrowUp"], "Fil precedent", () => nouvelle() && voisin(-1), "liste"],
    ["close", ["Escape"], "Fermer le fil ouvert", () => fermer()],
    ["send", ["Ctrl+Enter"], "Envoyer le message en cours", () => cliquer("Send")],
  ];

  const config = () => window.__ss2iShortcutsConfig || null;
  const touchesDe = (id, defaut) => {
    const c = config();
    const t = c && c.bindings && c.bindings[id];
    return Array.isArray(t) ? t : defaut;
  };

  // Meme normalisation que comboFromEvent (components/k/shortcuts-catalog.ts).
  const combinaison = (e) => {
    let key = e.key;
    if (!key || ["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock", "Dead", "Unidentified"].includes(key)) return null;
    if (key === " ") key = "Space";
    const altGr = typeof e.getModifierState === "function" && e.getModifierState("AltGraph");
    const unique = key.length === 1;
    const lettre = unique && /\p{L}/u.test(key);
    const mods = [];
    if (!(unique && !lettre && altGr)) {
      if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
    }
    if (e.shiftKey && (!unique || lettre)) mods.push("Shift");
    if (lettre) key = key.toLowerCase();
    return [...mods, key].join("+");
  };
  const avecModificateur = (combo) => combo.split("+").slice(0, -1).some((m) => m === "Ctrl" || m === "Alt");

  // Retrouve un bouton par son libellé visible, exactement puis en repli partiel.
  // ss2i nouvelle interface (<html data-ui="ss2i">) : ses boutons portent
  // data-k-action et des libelles en francais ; on les cherche d'abord par la.
  // L'interface classique n'a pas ces attributs : rien ne change pour elle.
  const nouvelle = () => document.documentElement.dataset.ui === "ss2i";
  const ACTIONS_K = { Compose: "compose", Reply: "reply", Forward: "forward", Archive: "archive", Delete: "delete", Send: "send" };
  const visible = (el) => el && el.offsetParent !== null;
  const cliquerK = (action) => {
    const cible = Array.from(document.querySelectorAll(`[data-k-action="${action}"]`)).filter(visible).pop();
    if (cible) cible.click();
    return Boolean(cible);
  };

  // Nouvelle interface : fil suivant / precedent de la liste (fleches, j, k).
  const voisin = (pas) => {
    const lignes = Array.from(document.querySelectorAll("li[data-thread-id]")).filter(visible);
    if (!lignes.length) return false;
    const i = lignes.findIndex((l) => l.getAttribute("aria-current") === "true");
    const cible = lignes[i < 0 ? 0 : Math.min(lignes.length - 1, Math.max(0, i + pas))];
    cible.click();
    cible.scrollIntoView({ block: "nearest" });
    return true;
  };

  const cliquer = (libelle) => {
    if (nouvelle() && ACTIONS_K[libelle] && cliquerK(ACTIONS_K[libelle])) return true;
    const boutons = Array.from(document.querySelectorAll("button, a[role=button]"));
    const cible =
      boutons.find((b) => b.textContent.trim() === libelle) ||
      boutons.find((b) => b.textContent.trim().startsWith(libelle));
    if (cible) cible.click();
    return Boolean(cible);
  };

  const dansUnMail = () => /\/threads\/[^/]+/.test(window.location.pathname);

  // Dans un mail ouvert : le bouton libelle du mail. Sur la liste : le bouton de la
  // barre de selection, marque data-ss2i-shortcut (mail-list-header.tsx) et visible
  // seulement si des mails sont coches ; sans selection, rien ne se passe. Jamais par
  // title : chaque ligne de la liste a ses propres boutons « Delete » / « Archive ».
  const surMailOuSelection = (libelle) => {
    if (dansUnMail()) return cliquer(libelle);
    const marque = libelle === "Delete" ? "selection-delete" : "selection-archive";
    const cible = Array.from(
      document.querySelectorAll(`button[data-ss2i-shortcut="${marque}"]`)
    ).find((b) => b.offsetParent !== null);
    if (cible) cible.click();
    return Boolean(cible);
  };

  // Non lu : seulement dans un mail ouvert (URL .../threads/<id>). Le bouton est une
  // icone sans texte, retrouvee par son aria-label ; il marque le fil non lu et
  // revient a la liste (email-renderer.tsx, unreadMessage).
  const marquerNonLu = () => {
    if (!dansUnMail()) return false;
    if (nouvelle() && cliquerK("unread")) return true;
    const cible = document.querySelector('button[aria-label="Mark as unread"]');
    if (cible) cible.click();
    return Boolean(cible);
  };

  // Nouvelle interface : ferme le fil ouvert (sauf fenetre ou menu ouvert).
  const fermer = () => {
    if (!nouvelle() || document.querySelector('[role="dialog"], [role="menu"]')) return false;
    return cliquerK("close");
  };

  const focaliserRecherche = () => {
    if (nouvelle() && cliquerK("search")) return true;
    const champ = document.querySelector('input[placeholder^="Search this mailbox"]');
    if (champ) champ.focus();
    return Boolean(champ);
  };

  const echapper = (t) =>
    String(t).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

  // L'utilisateur ne peut pas devenir un raccourci qu'il ignore : « ? » les liste.
  const basculerAide = () => {
    const existant = document.getElementById("ss2i-aide-raccourcis");
    if (existant) {
      existant.remove();
      return true;
    }
    const boite = document.createElement("div");
    boite.id = "ss2i-aide-raccourcis";
    boite.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(0,0,0,.55)";
    const c = config();
    const kbd = (touche) =>
      (nouvelle()
        ? `<kbd style="background:var(--k-hover);color:var(--k-ink);border:1px solid var(--k-line-strong);border-radius:5px;padding:.1rem .45rem;`
        : `<kbd style="background:#333;color:#fff;border-radius:4px;padding:.1rem .45rem;`) +
      `font-family:monospace;white-space:nowrap">${echapper(touche)}</kbd>`;
    // Avec la configuration de l'utilisateur : ses touches, libelles traduits.
    // Sans (avant son chargement) : les touches par defaut.
    const entrees = c && Array.isArray(c.help)
      ? c.help.map((h) => [h.keys, h.label])
      : RACCOURCIS.filter(([, , , , portee]) => nouvelle() || !portee)
          .filter(([id]) => nouvelle() || id !== "close")
          .map(([, touches, libelle]) => [touches, libelle]);
    const lignes = entrees
      .map(
        ([touches, libelle]) =>
          `<tr><td style="padding:.35rem .9rem .35rem 0;text-align:right">` +
          touches.map(kbd).join(" ") +
          `</td><td style="padding:.35rem 0">${echapper(libelle)}</td></tr>`
      )
      .join("");
    boite.innerHTML =
      (nouvelle()
        ? `<div style="background:var(--k-surface);color:var(--k-ink);border-radius:14px;padding:1.4rem 1.8rem;` +
          `font:13.5px var(--font-sans),system-ui;box-shadow:var(--k-shadow-pop);min-width:340px">`
        : `<div style="background:#1b1b1f;color:#eee;border-radius:12px;padding:1.5rem 2rem;` +
          `font:14px system-ui;box-shadow:0 10px 40px rgba(0,0,0,.5)">`) +
      `<div style="font-weight:600;margin-bottom:.9rem">${echapper((c && c.texts && c.texts.title) || "Raccourcis clavier")}</div>` +
      `<table>${lignes}</table>` +
      `<div style="margin-top:1rem;opacity:.6;font-size:12px">` +
      `${echapper((c && c.texts && c.texts.close) || "Echap ou ? pour fermer")}</div></div>`;
    boite.addEventListener("click", () => boite.remove());
    document.body.appendChild(boite);
    return true;
  };

  // Ne jamais voler une frappe destinee a un champ de saisie.
  const dansUneSaisie = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const t = el.tagName;
    // Une case a cocher n'est pas une saisie : apres avoir coche des mails, le focus
    // y reste et « e » doit agir sur la selection.
    if (t === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return false;
    return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
  };

  document.addEventListener(
    "keydown",
    (e) => {
      try {
        // Enregistrement d'une touche dans les parametres : on ne reagit pas.
        if (window.__ss2iShortcutsRecording) return;
        const combo = combinaison(e);
        if (!combo) return;

        // L'aide ouverte se ferme avec Echap ou sa propre touche.
        const aide = document.getElementById("ss2i-aide-raccourcis");
        if (aide && (combo === "Escape" || touchesDe("help", ["?"]).includes(combo))) {
          aide.remove();
          e.preventDefault();
          return;
        }

        const c = config();
        if (c && c.enabled === false) return;

        // Plusieurs actions peuvent partager une touche (ex. une action propre a
        // la nouvelle interface) : la premiere qui aboutit l'emporte.
        const entrees = RACCOURCIS.filter(([id, defaut]) => touchesDe(id, defaut).includes(combo));
        for (const [, , , action, portee] of entrees) {
          // Ne jamais voler une frappe destinee a un champ de saisie. Une combinaison
          // avec Ctrl ou Alt (ex. Ctrl+Entree pour envoyer) est attendue justement
          // depuis l'editeur, qui est un contenteditable (Tiptap/ProseMirror).
          if (!avecModificateur(combo) && dansUneSaisie(e.target)) return;

          // Navigation dans la liste : jamais dans un menu ou une fenetre.
          if (
            portee === "liste" &&
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
        // Un raccourci defaillant ne doit jamais empecher de taper.
        console.error("raccourcis clavier", err);
      }
    },
    true
  );
})();

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
    ["archiveFor", ["Shift+a"], "Archiver pour... (ouvre le menu des durees : le mail ouvert ou les mails coches)", () => archiverPour()],
    ["selectAll", ["Ctrl+a"], "Tout selectionner (les mails de la liste affichee)", () => toutSelectionner()],
    ["delete", ["e", "#"], "Supprimer (le mail ouvert ou les mails coches)", () => surMailOuSelection("Delete")],
    ["unread", ["u"], "Marquer non lu et revenir a la liste", () => marquerNonLu()],
    ["search", ["/"], "Rechercher", () => focaliserRecherche()],
    ["help", ["?"], "Afficher cette aide", () => basculerAide()],
    // Nouvelle interface seulement : navigation dans la liste et fermeture du fil.
    ["next", ["j", "ArrowDown"], "Fil suivant", () => nouvelle() && voisin(1), "liste"],
    ["prev", ["k", "ArrowUp"], "Fil precedent", () => nouvelle() && voisin(-1), "liste"],
    ["close", ["Escape"], "Fermer le fil ouvert", () => fermer()],
    // Jamais depuis une fenetre sans editeur (consigne de « Repondre avec Lore »...) : le
    // bouton Send trouve serait celui d'un brouillon ouvert derriere, envoye a l'aveugle.
    ["send", ["Ctrl+Enter"], "Envoyer le message en cours", () => !dansUneFenetreSansEditeur() && cliquer("Send")],
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
  // ss2i (20/11) : la liste reste montee sous le panneau du fil, invisible et inert ;
  // ses boutons ne doivent jamais etre vises.
  const visible = (el) => el && el.offsetParent !== null && !el.closest("[inert]");
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
    const boutons = Array.from(document.querySelectorAll("button, a[role=button]")).filter((b) => !b.closest("[inert]"));
    const cible =
      boutons.find((b) => b.textContent.trim() === libelle) ||
      boutons.find((b) => b.textContent.trim().startsWith(libelle));
    if (cible) cible.click();
    return Boolean(cible);
  };

  const dansUnMail = () => /\/threads\/[^/]+/.test(window.location.pathname);

  // Mail ouvert : chaque message a sa barre (Archive, Delete, Archiver pour...). Le raccourci vise
  // celle du message en cours de lecture, pas la premiere du fil : Maj+A ouvrait le menu sur le
  // premier message, tout en haut d'un fil long, hors de vue (Samuel le 23/11/2026).
  // tops : haut de chaque barre dans l'ordre du fil ; haut / bas : zone visible sous la barre du
  // haut collante. Rend la barre visible la plus haute, sinon la derniere au-dessus de l'ecran (le
  // message dont on lit le corps), sinon la premiere ; -1 sans barre.
  const choisirBarreLue = (tops, haut, bas) => {
    let dessus = -1;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i] >= haut && tops[i] < bas) return i;
      if (tops[i] < haut) dessus = i;
    }
    return dessus >= 0 ? dessus : tops.length ? 0 : -1;
  };
  const barreDuMessageLu = (marque) => {
    const boutons = Array.from(document.querySelectorAll(`button[data-ss2i-shortcut="${marque}"]`)).filter(visible);
    const haut = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ss2i-mail-header-h")) || 0;
    const i = choisirBarreLue(boutons.map((b) => b.getBoundingClientRect().top), haut, window.innerHeight);
    const bouton = i >= 0 ? boutons[i] : null;
    // Barre hors de l'ecran : ramenee juste sous la barre du haut, sinon le menu s'ouvre hors de vue.
    if (bouton) {
      const r = bouton.getBoundingClientRect();
      if (r.top < haut || r.bottom > window.innerHeight) window.scrollBy({ top: r.top - haut - 8, behavior: "instant" });
    }
    return bouton;
  };

  // Dans un mail ouvert : le bouton de la barre du message, marque data-ss2i-shortcut
  // (email-renderer.tsx), present sur chaque message ; repli sur le bouton libelle (nouvelle
  // interface). Pas le bouton texte du bas seul : il n'est rendu que sous le dernier message,
  // absent quand ce dernier est une reponse encore en Boite d'envoi (Samuel le 23/11).
  // Sur la liste : le bouton de la barre de selection, marque data-ss2i-shortcut
  // (mail-list-header.tsx) et visible seulement si des mails sont coches ; sans selection,
  // rien ne se passe. Jamais par title : chaque ligne de la liste a ses propres boutons
  // « Delete » / « Archive ».
  const surMailOuSelection = (libelle) => {
    if (dansUnMail()) {
      const barre = libelle === "Delete" ? "open-delete" : "open-archive";
      if (nouvelle() && ACTIONS_K[libelle] && cliquerK(ACTIONS_K[libelle])) return true;
      const bouton = barreDuMessageLu(barre);
      if (bouton) {
        bouton.click();
        return true;
      }
      return cliquer(libelle);
    }
    const marque = libelle === "Delete" ? "selection-delete" : "selection-archive";
    const cible = Array.from(
      document.querySelectorAll(`button[data-ss2i-shortcut="${marque}"]`)
    ).find(visible);
    if (cible) cible.click();
    return Boolean(cible);
  };

  // « Archiver pour... » (A, Maj+a) : ouvre le menu de KArchiveFor du meme contexte que `a`, le mail
  // ouvert ou la barre de selection (marque data-ss2i-shortcut posee par KArchiveFor, jamais par
  // title ni par data-k-action, que `a` garde). Pas de second menu : on clique le declencheur.
  // Menu ou fenetre deja ouvert : leur clavier leur appartient, rien ne se passe.
  const archiverPour = () => {
    if (document.querySelector('[role="menu"], [role="dialog"]')) return false;
    const cible = dansUnMail()
      ? barreDuMessageLu("open-archive-for")
      : Array.from(document.querySelectorAll('button[data-ss2i-shortcut="selection-archive-for"]')).find(visible);
    if (!cible || cible.disabled) return false;
    cible.click();
    rendreLeFocusAuMenu(8);
    return true;
  };
  // Ctrl+A sur une liste de mails : coche la case « tout selectionner » de l'en-tete
  // (data-ss2i-shortcut="select-all", mail-list-header.tsx et k/list-header.tsx), qui
  // coche les fils de la page. Ailleurs, Ctrl+A garde son effet natif : dans un champ,
  // pendant la redaction d'un mail, dans un menu ou une fenetre, ou sans liste visible
  // (mail ouvert en plein ecran) ou l'on peut vouloir selectionner le texte du mail.
  const toutSelectionner = () => {
    if (dansUneSaisie(document.activeElement) || composeurOuvert()) return false;
    if (document.querySelector('[role="menu"], [role="dialog"]')) return false;
    const cible = Array.from(document.querySelectorAll('input[data-ss2i-shortcut="select-all"]')).find(visible);
    if (!cible || cible.disabled) return false;
    if (!cible.checked) cible.click();
    return true;
  };
  // Mantine Menu piege le focus a l'ouverture ; sinon (declencheur remonte, rendu tardif) on le
  // pose sur le menu : fleches puis Entree choisissent une duree.
  const rendreLeFocusAuMenu = (essais) => {
    const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(visible);
    if (menu) {
      if (!menu.contains(document.activeElement)) menu.focus();
    } else if (essais > 0) setTimeout(() => rendreLeFocusAuMenu(essais - 1), 40);
  };

  // Non lu : seulement dans un mail ouvert (URL .../threads/<id>). Le bouton est une
  // icone sans texte, retrouvee par son aria-label ; il marque le fil non lu et
  // revient a la liste (email-renderer.tsx, unreadMessage).
  const marquerNonLu = () => {
    if (!dansUnMail()) return false;
    if (nouvelle() && cliquerK("unread")) return true;
    const cible = Array.from(document.querySelectorAll('button[aria-label="Mark as unread"]')).find(visible);
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
    // Shadow DOM (message cite ou transfere modifiable, reply-quote-editor.tsx) : la touche
    // et le focus visent la div hote ; la saisie est l'element actif a l'interieur. Sans cela
    // le verrou renvoyait la frappe sur « A » (Samuel le 06/11). Test : test/compose-focus.ts.
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const t = el.tagName;
    // Une case a cocher n'est pas une saisie : apres avoir coche des mails, le focus
    // y reste et « e » doit agir sur la selection.
    if (t === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return false;
    return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
  };

  // ---------------------------------------------------------------------------
  // VERROU DE SAISIE (Samuel, 04/11/2026). Pendant qu'on ecrit un mail, aucune
  // touche seule ne doit jamais devenir un raccourci, meme si le focus a quitte la
  // zone de texte (editeur redessine par un router.refresh, element retire du DOM,
  // clic dans une marge) : « Si on est en train de taper, il n'y a aucun raccourci
  // clavier qui est operationnel en dehors des raccourcis avec des combinaisons de
  // touches CTRL, ALT ». Regle : tant qu'un editeur de mail est ouvert,
  //  1. les raccourcis sans Ctrl / Alt / Meta sont coupes, ou que soit le focus ;
  //  2. une frappe qui tombe hors d'un champ est rendue a la derniere zone de saisie
  //     (meme position du curseur si l'element existe encore, sinon fin du corps) ;
  //  3. un focus perdu « dans le vide » (body) sans clic de l'utilisateur est rendu
  //     aussitot a la zone de saisie.
  // ---------------------------------------------------------------------------
  const EDITEUR = '.ProseMirror[contenteditable="true"]';
  const editeursOuverts = () => Array.from(document.querySelectorAll(EDITEUR)).filter(visible);
  const composeurOuvert = () => editeursOuverts().length > 0;
  let derniereSaisie = null; // dernier champ de saisie qui a eu le focus
  let derniereSelection = null; // { el, range } dans un contenteditable
  let dernierClic = 0;
  let derniereTab = 0;

  const utilisable = (el) => el && el.isConnected && visible(el) && dansUneSaisie(el);
  const cibleDeSaisie = () => {
    if (utilisable(derniereSaisie)) return derniereSaisie;
    const eds = editeursOuverts();
    return eds.length ? eds[eds.length - 1] : null;
  };
  // Focus perdu « dans le vide » : body, html, ou un conteneur non interactif.
  const focusDansLeVide = () => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return true;
    if (dansUneSaisie(a)) return false;
    return !a.matches('button, a[href], select, summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"], [role="slider"], input');
  };
  // Focus dans une fenetre qui n'a pas d'editeur de mail (Ctrl+Entree n'y envoie rien).
  const dansUneFenetreSansEditeur = () => {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('[role="dialog"]:not(:has(.ProseMirror))'));
  };
  // Menus, listes deroulantes, fenetres : leur clavier leur appartient.
  const dansUnePopup = (el) =>
    !!(el && el.closest && el.closest('[role="menu"], [role="listbox"], [role="dialog"]:not(:has(.ProseMirror)), [role="tree"], [role="combobox"]'));

  const rendreLeFocus = () => {
    const cible = cibleDeSaisie();
    if (!cible) return false;
    cible.focus({ preventScroll: true });
    // Curseur remis la ou il etait si l'element est le meme.
    if (derniereSelection && derniereSelection.el === cible && cible.isContentEditable) {
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(derniereSelection.range);
      } catch (_) {
        /* range devenu invalide : on garde le focus tel quel */
      }
    } else if (cible.isContentEditable && !cible.contains(window.getSelection()?.anchorNode || null)) {
      // Nouvel element (editeur redessine) : curseur en fin de texte.
      const r = document.createRange();
      r.selectNodeContents(cible);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return document.activeElement === cible;
  };

  window.addEventListener("pointerdown", () => (dernierClic = Date.now()), true);
  window.addEventListener(
    "focusin",
    (e) => {
      if (dansUneSaisie(e.target)) derniereSaisie = e.target;
    },
    true
  );
  document.addEventListener("selectionchange", () => {
    const a = document.activeElement;
    if (!a || !a.isContentEditable) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && a.contains(sel.anchorNode)) {
      derniereSelection = { el: a.closest('[contenteditable="true"]') || a, range: sel.getRangeAt(0).cloneRange() };
    }
  });
  window.addEventListener(
    "focusout",
    (e) => {
      if (!dansUneSaisie(e.target)) return;
      // Laisse le navigateur poser le nouveau focus, puis verifie ou il est tombe.
      setTimeout(() => {
        if (!document.hasFocus()) return; // autre fenetre, autre onglet
        if (Date.now() - dernierClic < 600) return; // l'utilisateur a clique ailleurs
        if (Date.now() - derniereTab < 600) return; // Tab : il change de champ
        if (!composeurOuvert() || !focusDansLeVide()) return;
        rendreLeFocus();
      }, 0);
    },
    true
  );

  // Phase de capture sur window, enregistree au chargement : passe avant tous les
  // autres ecouteurs clavier de la page (React, fenetres, raccourcis ci-dessous).
  window.addEventListener(
    "keydown",
    (e) => {
      try {
        if (e.key === "Tab") derniereTab = Date.now();
        if (window.__ss2iShortcutsRecording) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return; // combinaisons : toujours permises
        if (dansUneSaisie(e.target)) return; // frappe deja au bon endroit
        if (!composeurOuvert() || dansUnePopup(e.target)) return;
        const imprimable = e.key && e.key.length === 1;
        const edition = ["Backspace", "Delete", "Enter"].includes(e.key);
        // Espace et Entree activent un bouton qui a le focus (Tab jusqu'a Envoyer) :
        // on ne les detourne que si le focus est dans le vide.
        if ((e.key === " " || e.key === "Enter") && !focusDansLeVide()) return;
        if (!imprimable && !edition && e.key !== "Escape") return; // fleches, F1... : rien a voler
        // Plus aucun ecouteur ne voit cette touche comme un raccourci.
        e.stopImmediatePropagation();
        if (e.key === "Escape") return;
        // Le caractere part dans le champ qui recoit le focus pendant keydown.
        if (!rendreLeFocus()) e.preventDefault();
      } catch (err) {
        console.error("verrou de saisie", err);
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      try {
        // Enregistrement d'une touche dans les parametres : on ne reagit pas.
        if (window.__ss2iShortcutsRecording) return;
        // Un mail est en cours d'ecriture : aucune touche seule n'est un raccourci.
        if (!avecModificateur(combinaison(e) || "") && composeurOuvert()) return;
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

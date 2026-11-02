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

  const RACCOURCIS = [
    ["c", "Nouveau message", () => cliquer("Compose")],
    ["r", "Repondre", () => cliquer("Reply")],
    ["f", "Transferer", () => cliquer("Forward")],
    ["a", "Archiver (le mail ouvert ou les mails coches)", () => surMailOuSelection("Archive")],
    ["e", "Supprimer (le mail ouvert ou les mails coches)", () => surMailOuSelection("Delete")],
    ["#", "Supprimer (le mail ouvert ou les mails coches)", () => surMailOuSelection("Delete")],
    ["u", "Marquer non lu et revenir a la liste", () => marquerNonLu()],
    ["/", "Rechercher", () => focaliserRecherche()],
    ["?", "Afficher cette aide", () => basculerAide()],
  ];

  // Retrouve un bouton par son libellé visible, exactement puis en repli partiel.
  const cliquer = (libelle) => {
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
    const cible = document.querySelector('button[aria-label="Mark as unread"]');
    if (cible) cible.click();
    return Boolean(cible);
  };

  const focaliserRecherche = () => {
    const champ = document.querySelector('input[placeholder^="Search this mailbox"]');
    if (champ) champ.focus();
    return Boolean(champ);
  };

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
    const vues = new Set();
    const lignes = RACCOURCIS.filter(([, l]) => !vues.has(l) && vues.add(l))
      .map(
        ([touche, libelle]) =>
          `<tr><td style="padding:.35rem .9rem .35rem 0;text-align:right">` +
          `<kbd style="background:#333;color:#fff;border-radius:4px;padding:.1rem .45rem;` +
          `font-family:monospace">${touche}</kbd></td>` +
          `<td style="padding:.35rem 0">${libelle}</td></tr>`
      )
      .join("");
    boite.innerHTML =
      `<div style="background:#1b1b1f;color:#eee;border-radius:12px;padding:1.5rem 2rem;` +
      `font:14px system-ui;box-shadow:0 10px 40px rgba(0,0,0,.5)">` +
      `<div style="font-weight:600;margin-bottom:.9rem">Raccourcis clavier</div>` +
      `<table>${lignes}</table>` +
      `<div style="margin-top:1rem;opacity:.6;font-size:12px">` +
      `Echap ou ? pour fermer</div></div>`;
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
        // ENVOI : Ctrl+Entree / Cmd+Entree. Double exception assumee aux deux
        // garde-fous ci-dessous — c'est un modificateur, ET on l'attend justement
        // DEPUIS l'editeur, qui est un contenteditable (Tiptap/ProseMirror).
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          if (cliquer("Send")) e.preventDefault();
          return;
        }

        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (dansUneSaisie(e.target)) return;

        if (e.key === "Escape") {
          const aide = document.getElementById("ss2i-aide-raccourcis");
          if (aide) {
            aide.remove();
            e.preventDefault();
          }
          return;
        }

        const entree = RACCOURCIS.find(([touche]) => touche === e.key);
        if (!entree) return;
        if (entree[2]()) e.preventDefault();
      } catch (err) {
        // Un raccourci defaillant ne doit jamais empecher de taper.
        console.error("raccourcis clavier", err);
      }
    },
    true
  );
})();

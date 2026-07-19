const dict = {
  en: {
    import: 'Import (STL/OBJ/GLB/3MF)',
    export: 'Export',
    exportStl: 'STL (one file per piece)',
    export3mf: '3MF (all pieces)',
    exportGlb: 'GLB (all pieces)',
    exportObj: 'OBJ (all pieces)',
    planeCut: 'Plane cut',
    axis: 'Axis',
    offset: 'Offset',
    tiltA: 'Tilt A',
    tiltB: 'Tilt B',
    kerf: 'Kerf (mm)',
    connectors: 'Alignment pins',
    pinDiameter: 'Pin diameter (mm)',
    pinLength: 'Pin length (mm)',
    tolerance: 'Tolerance (mm)',
    cut: '✂ Cut',
    cutting: 'Cutting…',
    undo: 'Undo last cut',
    pieces: 'Pieces',
    explode: 'Exploded view',
    dropHint: 'Drop a 3D model here or use Import',
    loadError: 'Failed to load {{name}}',
    cutError:
      'Cut failed. The mesh may contain geometric errors (flipped faces, holes, non-manifold edges).',
    piece: 'Piece'
  },
  fr: {
    import: 'Importer (STL/OBJ/GLB/3MF)',
    export: 'Exporter',
    exportStl: 'STL (un fichier par pièce)',
    export3mf: '3MF (toutes les pièces)',
    exportGlb: 'GLB (toutes les pièces)',
    exportObj: 'OBJ (toutes les pièces)',
    planeCut: 'Coupe par plan',
    axis: 'Axe',
    offset: 'Position',
    tiltA: 'Inclinaison A',
    tiltB: 'Inclinaison B',
    kerf: 'Jeu de coupe (mm)',
    connectors: "Tenons d'alignement",
    pinDiameter: 'Diamètre tenon (mm)',
    pinLength: 'Longueur tenon (mm)',
    tolerance: 'Tolérance (mm)',
    cut: '✂ Couper',
    cutting: 'Découpe…',
    undo: 'Annuler la dernière coupe',
    pieces: 'Pièces',
    explode: 'Vue éclatée',
    dropHint: 'Dépose un modèle 3D ici ou utilise Importer',
    loadError: 'Erreur lors du chargement de {{name}}',
    cutError:
      'La découpe a échoué. Le maillage contient peut-être des erreurs géométriques (faces inversées, trous, arêtes non-manifold).',
    piece: 'Pièce'
  }
}

export function makeT(lang) {
  return (key, params = {}) => {
    let s = dict[lang]?.[key] ?? dict.en[key] ?? key
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{{${k}}}`, v)
    return s
  }
}

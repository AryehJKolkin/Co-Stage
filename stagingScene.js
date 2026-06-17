// CoStage staging scene — generates a template-room SpatialScene + furniture
// placements for the homepage demo, and renders them with three.js.
//
// Loaded as a classic <script> after the SpatialParser module shim and three.js
// have been added to the page. Exposes everything via window.StagingScene.
//
// Note on CameraPose field naming: SpatialParser.createMockScene() labels its
// matrices in a way that's swapped from the usual convention — a CameraPose's
// `worldToCamera` field is actually the camera-to-world matrix (translation =
// camera position, rotation columns = camera's right/up/back axes in world
// space), and `cameraToWorld` is the world-to-camera view matrix. This was
// confirmed empirically (see session notes). Everything below uses
// `cam.worldToCamera` wherever camera position/orientation is needed.

(function () {
  const ROOM_PRESETS = {
    'living room': { width: 5.2, depth: 4.1, height: 2.6 },
    'bedroom':     { width: 4.0, depth: 3.6, height: 2.6 },
    'dining room': { width: 4.6, depth: 3.8, height: 2.6 },
  };

  const CATEGORY_TO_FURNITURE = {
    'sofa':         { id: 'sofa-3seat', w: 2.2, d: 0.95 },
    'armchair':     { id: 'armchair',   w: 0.9, d: 0.9  },
    'side table':   { id: 'nightstand', w: 0.5, d: 0.45 },
    'coffee table': { id: 'coffee-tbl', w: 1.2, d: 0.6  },
    'dining table': { id: 'dining-tbl', w: 1.8, d: 0.9  },
    'dining chair': { id: 'dining-chr', w: 0.5, d: 0.5  },
    'bed':          { id: 'bed-queen',  w: 1.6, d: 2.0  },
    'nightstand':   { id: 'nightstand', w: 0.5, d: 0.45 },
    'plant':        { id: 'plant',      w: 0.5, d: 0.5  },
    'rug':          { id: 'rug-lg',     w: 2.4, d: 1.7  },
  };
  const DEFAULT_FURNITURE = { id: 'bookshelf', w: 0.8, d: 0.3 };

  const FURN_COLORS = {
    'sofa-3seat': 0x8B7355, 'sofa-2seat': 0x8B7355, 'armchair': 0x7A8B6F,
    'coffee-tbl': 0x6B5B45, 'dining-tbl': 0x6B5B45, 'dining-chr': 0x5A6B8A,
    'bed-king': 0x7B8B9A,   'bed-queen': 0x7B8B9A,  'nightstand': 0x8A7B6A,
    'dresser': 0x8A7B6A,    'desk': 0x6A7B8A,        'bookshelf': 0x7A6B5A,
    'tv-unit': 0x5A5A5A,    'wardrobe': 0x7A6B5A,    'rug-lg': 0x9A8B7A,
    'plant': 0x5A8A6A,
  };

  // ── Category guessing ──────────────────────────────────────────────────────
  function guessCategory(pick) {
    if (pick.category && CATEGORY_TO_FURNITURE[pick.category]) return pick.category;
    const n = (pick.name || '').toLowerCase();
    if (n.includes('sofa') || n.includes('couch')) return 'sofa';
    if (n.includes('dining') && n.includes('chair')) return 'dining chair';
    if (n.includes('dining') && n.includes('table')) return 'dining table';
    if (n.includes('chair')) return 'armchair';
    if (n.includes('coffee')) return 'coffee table';
    if (n.includes('table')) return 'side table';
    if (n.includes('bed')) return 'bed';
    if (n.includes('nightstand')) return 'nightstand';
    if (n.includes('rug')) return 'rug';
    if (n.includes('plant')) return 'plant';
    return 'misc';
  }

  // ── Layout ──────────────────────────────────────────────────────────────────
  function buildSceneForRoom(roomType, picks) {
    const preset = ROOM_PRESETS[roomType] || ROOM_PRESETS['living room'];
    const scene = SpatialParser.createMockScene(Object.assign({ photoCount: 8 }, preset));
    const { width, depth } = scene.roomDimensions;
    const hw = width / 2, hd = depth / 2;

    const placements = [];
    const placedPicks = new Set();

    const byCategory = {};
    picks.forEach(p => {
      const cat = guessCategory(p);
      (byCategory[cat] = byCategory[cat] || []).push(p);
    });

    function faceCenter(x, z) {
      return Math.atan2(x, z) * 180 / Math.PI;
    }
    function place(pick, x, z, rotation) {
      const fc = CATEGORY_TO_FURNITURE[guessCategory(pick)] || DEFAULT_FURNITURE;
      const rot = rotation === 'face-center' ? faceCenter(x, z) : rotation;
      placements.push({
        furnitureId: fc.id,
        name: pick.name,
        worldPosition: { x, z },
        rotation: rot,
        dimensions: { width: fc.w, depth: fc.d },
        _pickRef: pick,
      });
      placedPicks.add(pick);
    }
    function placeOne(cat, x, z, rotation) {
      const arr = byCategory[cat];
      if (arr && arr.length) place(arr.shift(), x, z, rotation);
    }
    function placeMany(cat, positions, rotation) {
      const arr = byCategory[cat];
      if (!arr) return;
      positions.forEach(pos => {
        if (!arr.length) return;
        place(arr.shift(), pos.x, pos.z, rotation);
      });
    }

    if (roomType === 'bedroom') {
      placeOne('bed', 0, hd - 1.1, 'face-center');
      placeMany('nightstand', [{ x: -1.15, z: hd - 0.5 }, { x: 1.15, z: hd - 0.5 }], 0);
      placeOne('rug', 0, hd * 0.05, 0);
      placeOne('plant', hw - 0.4, -hd + 0.4, 'face-center');
    } else if (roomType === 'dining room') {
      placeOne('dining table', 0, 0, 0);
      placeMany('dining chair', [
        { x: 0, z: -0.85 }, { x: 0, z: 0.85 },
        { x: -1.0, z: 0 },  { x: 1.0, z: 0 },
      ], 'face-center');
      placeOne('rug', 0, 0, 0);
      placeOne('plant', -hw + 0.4, hd - 0.4, 'face-center');
    } else {
      // living room (default)
      placeOne('sofa', -hw * 0.1, hd - 0.6, 'face-center');
      placeOne('coffee table', -hw * 0.1, hd * 0.15, 0);
      placeOne('armchair', hw * 0.5, hd * 0.25, 'face-center');
      placeOne('side table', hw * 0.55, hd - 0.5, 0);
      placeOne('rug', -hw * 0.05, hd * 0.2, 0);
      placeOne('plant', -hw + 0.4, hd - 0.4, 'face-center');
    }

    // Anything left over (categories not handled above, or extras) — stack along the left wall.
    let leftoverZ = -hd + 0.5;
    picks.forEach(pick => {
      if (placedPicks.has(pick)) return;
      const fc = CATEGORY_TO_FURNITURE[guessCategory(pick)] || DEFAULT_FURNITURE;
      const z = Math.min(leftoverZ, hd - fc.d / 2 - 0.1);
      place(pick, -hw + fc.w / 2 + 0.15, z, 90);
      leftoverZ += fc.d + 0.3;
    });

    return { scene, placements };
  }

  // ── Camera selection ───────────────────────────────────────────────────────
  // The mock scene's 8 perimeter cameras sit at a fixed radius that's often
  // well inside the room, so for small rooms with large furniture they can end
  // up nearly on top of (or inside) a placement, producing a near-clipped
  // close-up. Instead, build a custom camera looking in from a room corner —
  // pulled in from the walls and kept clear of furniture — toward the
  // furniture's centroid, like a photo taken from just inside the doorway.
  function _vnorm(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }
  function _vcross(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  }

  function chooseAfterCamera(scene, placements) {
    const { width, depth } = scene.roomDimensions;
    const hw = width / 2, hd = depth / 2;

    const pts = placements.length ? placements.map(p => p.worldPosition) : [{ x: 0, z: 0 }];
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;

    const MARGIN = 0.4;     // how far the camera sits in from the walls
    const CLEARANCE = 0.4;  // minimum gap to keep from any furniture footprint
    const EYE_HEIGHT = 1.4;
    const TARGET_HEIGHT = 0.6;

    const clearanceAt = (px, pz) => placements.reduce((min, p) => {
      const r = Math.hypot(p.dimensions.width, p.dimensions.depth) / 2;
      const d = Math.hypot(px - p.worldPosition.x, pz - p.worldPosition.z) - r;
      return Math.min(min, d);
    }, Infinity);

    const corners = [
      { x: hw - MARGIN, z: hd - MARGIN },
      { x: -(hw - MARGIN), z: hd - MARGIN },
      { x: hw - MARGIN, z: -(hd - MARGIN) },
      { x: -(hw - MARGIN), z: -(hd - MARGIN) },
    ];

    const scored = corners.map(c => ({
      corner: c,
      clearance: clearanceAt(c.x, c.z),
      distToCentroid: Math.hypot(c.x - cx, c.z - cz),
    }));

    const candidates = scored.filter(s => s.clearance >= CLEARANCE);
    const pool = candidates.length ? candidates : scored;
    pool.sort((a, b) => (b.clearance - a.clearance) || (b.distToCentroid - a.distToCentroid));
    const best = pool[0];

    const eye = { x: best.corner.x, y: EYE_HEIGHT, z: best.corner.z };
    const target = { x: cx, y: TARGET_HEIGHT, z: cz };

    // Build a camera-to-world matrix (per the `worldToCamera` field convention
    // noted above): columns = camera's right/up/back axes in world space, plus
    // the eye position as translation.
    const back = _vnorm({ x: eye.x - target.x, y: eye.y - target.y, z: eye.z - target.z });
    const right = _vnorm(_vcross({ x: 0, y: 1, z: 0 }, back));
    const up = _vcross(back, right);

    return {
      worldToCamera: [
        right.x, right.y, right.z, 0,
        up.x, up.y, up.z, 0,
        back.x, back.y, back.z, 0,
        eye.x, eye.y, eye.z, 1,
      ],
      fovY: (60 * Math.PI) / 180,
      aspectRatio: 4 / 3,
    };
  }

  // ── Three.js setup / render pipeline ───────────────────────────────────────
  function initRenderer(canvas) {
    if (canvas._stagingCtx) return canvas._stagingCtx;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xeef0f2, 1);

    const scene3d = new THREE.Scene();
    const camera3d = new THREE.PerspectiveCamera(60, 1, 0.01, 100);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.near = 0.1;
    dirLight.shadow.camera.far = 20;
    dirLight.shadow.camera.left = dirLight.shadow.camera.bottom = -5;
    dirLight.shadow.camera.right = dirLight.shadow.camera.top = 5;
    dirLight.position.set(3, 5, 3);
    scene3d.add(ambient, dirLight);

    const ctx = { renderer, scene3d, camera3d, ambient, dirLight, roomShell: null, roomKey: null };
    canvas._stagingCtx = ctx;
    return ctx;
  }

  function buildRoomShell(ctx, roomDimensions) {
    const { scene3d } = ctx;
    const key = roomDimensions.width + 'x' + roomDimensions.depth + 'x' + roomDimensions.height;
    if (ctx.roomKey === key) return;
    if (ctx.roomShell) {
      ctx.roomShell.forEach(m => scene3d.remove(m));
    }

    const { width, depth, height } = roomDimensions;
    const hw = width / 2, hd = depth / 2;
    const meshes = [];

    const floorMat = new THREE.MeshStandardMaterial({ color: 0xd8c6ab, roughness: 0.9 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    meshes.push(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2efe9, roughness: 0.95, side: THREE.DoubleSide });

    const wallBack = new THREE.Mesh(new THREE.PlaneGeometry(width, height), wallMat);
    wallBack.position.set(0, height / 2, hd);
    wallBack.rotation.y = Math.PI;

    const wallFront = new THREE.Mesh(new THREE.PlaneGeometry(width, height), wallMat);
    wallFront.position.set(0, height / 2, -hd);

    const wallLeft = new THREE.Mesh(new THREE.PlaneGeometry(depth, height), wallMat);
    wallLeft.position.set(-hw, height / 2, 0);
    wallLeft.rotation.y = Math.PI / 2;

    const wallRight = new THREE.Mesh(new THREE.PlaneGeometry(depth, height), wallMat);
    wallRight.position.set(hw, height / 2, 0);
    wallRight.rotation.y = -Math.PI / 2;

    [wallBack, wallFront, wallLeft, wallRight].forEach(w => { w.receiveShadow = true; meshes.push(w); });

    meshes.forEach(m => { m.userData.isRoomShell = true; scene3d.add(m); });
    ctx.roomShell = meshes;
    ctx.roomKey = key;
  }

  // Ported verbatim from compositor.html's buildFurnitureMesh.
  function buildFurnitureMesh(placement) {
    const { furnitureId, dimensions } = placement;
    const w = dimensions.width;
    const d = dimensions.depth;
    const color = FURN_COLORS[furnitureId] || 0x888888;
    const group = new THREE.Group();

    if (furnitureId.startsWith('sofa') || furnitureId === 'armchair') {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0 });
      const seat = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, d * 0.65), mat);
      seat.position.set(0, 0.225, d * 0.1);
      seat.castShadow = true; seat.receiveShadow = true;
      const back = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, d * 0.2), mat);
      back.position.set(0, 0.65, d * 0.45);
      back.castShadow = true;
      const armL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, d * 0.65), mat);
      armL.position.set(-w / 2 + 0.06, 0.275, d * 0.1);
      armL.castShadow = true;
      const armR = armL.clone();
      armR.position.x = w / 2 - 0.06;
      group.add(seat, back, armL, armR);
    } else if (furnitureId.startsWith('bed')) {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.0 });
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), mat);
      frame.position.y = 0.15; frame.castShadow = true; frame.receiveShadow = true;
      const mattress = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, 0.25, d - 0.5),
        new THREE.MeshStandardMaterial({ color: 0xf0ede8, roughness: 0.95 }));
      mattress.position.set(0, 0.425, -0.1); mattress.castShadow = true;
      const headboard = new THREE.Mesh(new THREE.BoxGeometry(w, 0.8, 0.1), mat);
      headboard.position.set(0, 0.6, d / 2); headboard.castShadow = true;
      group.add(frame, mattress, headboard);
    } else if (furnitureId === 'plant') {
      const potMat = new THREE.MeshStandardMaterial({ color: 0x8B6550, roughness: 0.9 });
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.12, 0.28, 12), potMat);
      pot.position.y = 0.14; pot.castShadow = true;
      const foliageMat = new THREE.MeshStandardMaterial({ color: 0x3D7A4A, roughness: 1.0 });
      const foliage = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), foliageMat);
      foliage.position.y = 0.72; foliage.castShadow = true;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6),
        new THREE.MeshStandardMaterial({ color: 0x4A6B3A }));
      stem.position.y = 0.42;
      group.add(pot, stem, foliage);
    } else if (furnitureId === 'rug-lg') {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 1.0 });
      const rug = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), mat);
      rug.position.y = 0.01; rug.receiveShadow = true;
      group.add(rug);
    } else if (furnitureId.includes('chr')) {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05 });
      const seatH = 0.45;
      const seat = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), mat);
      seat.position.y = seatH; seat.castShadow = true; seat.receiveShadow = true;
      const back = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, 0.06), mat);
      back.position.set(0, seatH + 0.2, d / 2 - 0.03);
      back.castShadow = true;
      group.add(seat, back);
      const legGeo = new THREE.CylinderGeometry(0.02, 0.02, seatH, 6);
      [[w / 2 - 0.03, d / 2 - 0.03], [w / 2 - 0.03, -(d / 2 - 0.03)], [-(w / 2 - 0.03), d / 2 - 0.03], [-(w / 2 - 0.03), -(d / 2 - 0.03)]].forEach(([lx, lz]) => {
        const leg = new THREE.Mesh(legGeo, mat);
        leg.position.set(lx, seatH / 2, lz); leg.castShadow = true;
        group.add(leg);
      });
    } else {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05 });
      const h = furnitureId.includes('shelf') || furnitureId.includes('wardrobe') ? 1.8
              : furnitureId.includes('tbl') || furnitureId.includes('desk') ? 0.75
              : furnitureId.includes('chr') ? 0.85 : 0.8;
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      body.position.y = h / 2; body.castShadow = true; body.receiveShadow = true;
      group.add(body);
      if (furnitureId.includes('tbl') || furnitureId.includes('desk')) {
        const legGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6);
        [[w / 2 - 0.05, d / 2 - 0.05], [w / 2 - 0.05, -(d / 2 - 0.05)], [-(w / 2 - 0.05), d / 2 - 0.05], [-(w / 2 - 0.05), -(d / 2 - 0.05)]].forEach(([lx, lz]) => {
          const leg = new THREE.Mesh(legGeo, mat);
          leg.position.set(lx, 0.35, lz); leg.castShadow = true;
          group.add(leg);
        });
      }
    }
    return group;
  }

  function buildAllModels(ctx, placements, roomDimensions) {
    const { scene3d } = ctx;
    buildRoomShell(ctx, roomDimensions);
    scene3d.children.filter(c => c.userData.isFurniture).forEach(c => scene3d.remove(c));
    placements.forEach(p => {
      const mesh = buildFurnitureMesh(p);
      mesh.userData.isFurniture = true;
      mesh.userData.placementId = p.furnitureId;
      mesh.position.set(p.worldPosition.x, 0, p.worldPosition.z);
      mesh.rotation.y = (p.rotation || 0) * Math.PI / 180;
      scene3d.add(mesh);
    });
  }

  // ── Camera sync ─────────────────────────────────────────────────────────────
  function syncCameraToPose(camera3d, cam, aspectOverride) {
    const m4 = cam.worldToCamera; // true camera-to-world matrix (see header note)
    camera3d.position.set(m4[12], m4[13], m4[14]);
    const m = new THREE.Matrix4();
    m.set(
      m4[0], m4[4], m4[8], m4[12],
      m4[1], m4[5], m4[9], m4[13],
      m4[2], m4[6], m4[10], m4[14],
      m4[3], m4[7], m4[11], m4[15]
    );
    camera3d.setRotationFromMatrix(m);
    camera3d.fov = cam.fovY * 180 / Math.PI;
    camera3d.aspect = aspectOverride || cam.aspectRatio;
    camera3d.updateProjectionMatrix();
  }

  // ── Offscreen render to a data URL ─────────────────────────────────────────
  let offscreenCanvas = null;

  async function renderToDataURL(placements, scene, cameraPose, opts) {
    opts = opts || {};
    const width = opts.width || 1024;
    const height = opts.height || 768;

    if (!offscreenCanvas) offscreenCanvas = document.createElement('canvas');
    const ctx = initRenderer(offscreenCanvas);
    ctx.renderer.setSize(width, height, false);

    buildAllModels(ctx, placements, scene.roomDimensions);
    syncCameraToPose(ctx.camera3d, cameraPose, width / height);
    ctx.dirLight.position.set(
      ctx.camera3d.position.x + 2,
      ctx.camera3d.position.y + 3,
      ctx.camera3d.position.z + 1
    );

    ctx.renderer.render(ctx.scene3d, ctx.camera3d);
    return offscreenCanvas.toDataURL('image/png');
  }

  window.StagingScene = {
    ROOM_PRESETS,
    CATEGORY_TO_FURNITURE,
    buildSceneForRoom,
    chooseAfterCamera,
    initRenderer,
    buildAllModels,
    syncCameraToPose,
    renderToDataURL,
  };
})();

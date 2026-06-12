/**
 * CoStage Spatial Parser
 * Parses image-blaster / World Labs Marble output into CoStage-ready data structures.
 *
 * image-blaster outputs a scene graph after Gaussian splat reconstruction. This parser
 * extracts the three things CoStage needs:
 *   1. Floor polygon (2D room outline for the floor plan editor)
 *   2. Camera poses (4x4 matrices, one per input photo)
 *   3. Room dimensions (bounding box in metres)
 */

// ---------------------------------------------------------------------------
// Types (JSDoc — no build step required)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Vec3
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

/**
 * @typedef {Object} Vec2
 * @property {number} x
 * @property {number} y
 */

/**
 * A 4x4 column-major transform matrix, stored as a flat 16-element array.
 * Matches the convention used by Three.js Matrix4 and most WebGL tooling.
 * @typedef {number[]} Mat4
 */

/**
 * @typedef {Object} CameraPose
 * @property {string} photoId     - matches the filename / key from the upload
 * @property {Mat4}   worldToCamera - view matrix (world → camera space)
 * @property {Mat4}   cameraToWorld - inverse view matrix (camera → world space)
 * @property {number} fovY          - vertical field of view in radians
 * @property {number} aspectRatio
 * @property {{ width: number, height: number }} imageSize - original photo resolution
 */

/**
 * @typedef {Object} SpatialScene
 * @property {Vec2[]}       floorPolygon  - ordered 2D points of room footprint (metres)
 * @property {{ width: number, depth: number, height: number }} roomDimensions
 * @property {CameraPose[]} cameras
 * @property {Vec3}         floorNormal   - usually (0,1,0) in Y-up scenes
 * @property {number}       floorY        - Y coordinate of the floor plane in world space
 * @property {string}       sourceFormat  - 'image-blaster' | 'colmap' | 'mock'
 */

// ---------------------------------------------------------------------------
// image-blaster output parser
// ---------------------------------------------------------------------------

/**
 * Parse the JSON payload that image-blaster writes after a Gaussian splat
 * reconstruction. The payload is written to output/<scene-id>/scene.json.
 *
 * Expected top-level shape (image-blaster v1):
 * {
 *   "scene_id": "...",
 *   "camera_poses": [
 *     {
 *       "image": "input/photo_01.jpg",
 *       "width": 4032, "height": 3024,
 *       "fl_x": 3200, "fl_y": 3200,   // focal lengths in pixels
 *       "cx": 2016, "cy": 1512,        // principal point
 *       "transform_matrix": [[...],[...],[...],[...]]  // 4x4 c2w
 *     }, ...
 *   ],
 *   "floor_plane": {
 *     "normal": [0, 1, 0],
 *     "offset": -0.02            // signed distance from origin
 *   },
 *   "bounding_box": {
 *     "min": [-2.1, -0.02, -1.8],
 *     "max": [ 2.1,  2.45,  1.8]
 *   },
 *   "floor_polygon": [           // convex hull of floor points (XZ plane)
 *     [x, z], [x, z], ...
 *   ]
 * }
 *
 * @param {Object} raw - parsed JSON from image-blaster scene.json
 * @returns {SpatialScene}
 */
export function parseImageBlasterOutput(raw) {
  _validateImageBlasterShape(raw);

  const floorY = _extractFloorY(raw.floor_plane);
  const floorNormal = _vecFromArray(raw.floor_plane.normal);

  const cameras = raw.camera_poses.map(cp => _parseCameraPose(cp));

  const floorPolygon = raw.floor_polygon
    ? raw.floor_polygon.map(([x, z]) => ({ x, y: z }))
    : _deriveFloorPolygonFromBBox(raw.bounding_box);

  const roomDimensions = _extractRoomDimensions(raw.bounding_box);

  return {
    floorPolygon,
    roomDimensions,
    cameras,
    floorNormal,
    floorY,
    sourceFormat: 'image-blaster',
  };
}

// ---------------------------------------------------------------------------
// COLMAP parser (alternative input path, same output shape)
// ---------------------------------------------------------------------------

/**
 * Parse COLMAP's cameras.json + images.json (as produced by colmap2nerf or
 * the COLMAP GUI JSON export). Useful if you run COLMAP server-side instead
 * of image-blaster.
 *
 * @param {Object} camerasJson  - COLMAP cameras.json content
 * @param {Object} imagesJson   - COLMAP images.json content
 * @param {{ floorY?: number, roomBbox?: Object }} hints - optional manual hints
 * @returns {SpatialScene}
 */
export function parseColmapOutput(camerasJson, imagesJson, hints = {}) {
  const floorY = hints.floorY ?? 0;
  const cameras = [];

  for (const [imageId, imgData] of Object.entries(imagesJson)) {
    const camData = camerasJson[imgData.camera_id];
    if (!camData) continue;

    const c2w = _colmapQvecTvecToMat4(imgData.qvec, imgData.tvec);
    const w2c = _invertMat4(c2w);
    const fovY = _focalToFov(camData.params[0], camData.height);

    cameras.push({
      photoId: imgData.name,
      worldToCamera: w2c,
      cameraToWorld: c2w,
      fovY,
      aspectRatio: camData.width / camData.height,
      imageSize: { width: camData.width, height: camData.height },
    });
  }

  const floorPolygon = hints.roomBbox
    ? _deriveFloorPolygonFromBBox(hints.roomBbox)
    : _estimateFloorPolygonFromCameras(cameras);

  const roomDimensions = hints.roomBbox
    ? _extractRoomDimensions(hints.roomBbox)
    : _estimateDimensionsFromCameras(cameras);

  return {
    floorPolygon,
    roomDimensions,
    cameras,
    floorNormal: { x: 0, y: 1, z: 0 },
    floorY,
    sourceFormat: 'colmap',
  };
}

// ---------------------------------------------------------------------------
// Mock generator — useful for UI development without running image-blaster
// ---------------------------------------------------------------------------

/**
 * Generate a realistic mock SpatialScene for a rectangular room.
 * @param {{ width?: number, depth?: number, height?: number, photoCount?: number }} opts
 * @returns {SpatialScene}
 */
export function createMockScene({
  width = 5.2,
  depth = 4.1,
  height = 2.6,
  photoCount = 6,
} = {}) {
  const hw = width / 2;
  const hd = depth / 2;

  // Simple rectangular floor polygon
  const floorPolygon = [
    { x: -hw, y: -hd },
    { x:  hw, y: -hd },
    { x:  hw, y:  hd },
    { x: -hw, y:  hd },
  ];

  // Cameras placed around the perimeter looking inward
  const cameras = Array.from({ length: photoCount }, (_, i) => {
    const angle = (i / photoCount) * Math.PI * 2;
    const r = Math.max(hw, hd) * 0.75;
    const px = Math.cos(angle) * r;
    const pz = Math.sin(angle) * r;
    const py = 1.2; // eye height

    const c2w = _lookAtMat4(
      { x: px, y: py, z: pz },
      { x: 0,  y: py, z: 0  },
      { x: 0,  y: 1,  z: 0  }
    );

    return {
      photoId: `photo_${String(i + 1).padStart(2, '0')}.jpg`,
      worldToCamera: _invertMat4(c2w),
      cameraToWorld: c2w,
      fovY: (60 * Math.PI) / 180,
      aspectRatio: 4 / 3,
      imageSize: { width: 4032, height: 3024 },
    };
  });

  return {
    floorPolygon,
    roomDimensions: { width, depth, height },
    cameras,
    floorNormal: { x: 0, y: 1, z: 0 },
    floorY: 0,
    sourceFormat: 'mock',
  };
}

// ---------------------------------------------------------------------------
// Projection utilities — used by the floor plan editor to place furniture
// ---------------------------------------------------------------------------

/**
 * Project a world-space floor position into 2D pixel coordinates for a given photo.
 *
 * This is the core of CoStage's multi-angle consistency: one floor plan position
 * produces the correct pixel location in every photo automatically.
 *
 * @param {{ x: number, z: number }} floorPos  - position in metres on the floor plane
 * @param {CameraPose} camera
 * @param {number} furnitureHeight              - height of the furniture's centroid (metres)
 * @returns {{ u: number, v: number, depth: number, visible: boolean }}
 *   u/v are normalised [0,1] pixel coordinates. depth is distance from camera.
 *   visible is false if the point is behind the camera.
 */
export function projectToPhoto(floorPos, camera, furnitureHeight = 0.45) {
  // World position (Y-up, furniture centroid sits at half its height)
  const worldPos = {
    x: floorPos.x,
    y: furnitureHeight,
    z: floorPos.z,
  };

  // Transform to camera space using the view matrix
  const camPos = _transformPoint(worldPos, camera.worldToCamera);

  // Behind camera?
  if (camPos.z >= 0) {
    return { u: 0, v: 0, depth: camPos.z, visible: false };
  }

  const depth = -camPos.z; // positive distance

  // Perspective divide
  const tanHalfFovY = Math.tan(camera.fovY / 2);
  const tanHalfFovX = tanHalfFovY * camera.aspectRatio;

  const ndcX =  camPos.x / (depth * tanHalfFovX);
  const ndcY = -camPos.y / (depth * tanHalfFovY); // flip Y for image coords

  // NDC [-1,1] → normalised UV [0,1]
  const u = (ndcX + 1) / 2;
  const v = (ndcY + 1) / 2;

  const visible = u >= 0 && u <= 1 && v >= 0 && v <= 1;

  return { u, v, depth, visible };
}

/**
 * Convert normalised UV to pixel coordinates.
 * @param {{ u: number, v: number }} uv
 * @param {{ width: number, height: number }} imageSize
 * @returns {{ px: number, py: number }}
 */
export function uvToPixels(uv, imageSize) {
  return {
    px: Math.round(uv.u * imageSize.width),
    py: Math.round(uv.v * imageSize.height),
  };
}

/**
 * Estimate the projected scale of a furniture item in a photo.
 * Returns the fraction of the image height the item would occupy.
 *
 * @param {number} itemHeightMetres
 * @param {number} depthMetres       - from projectToPhoto().depth
 * @param {CameraPose} camera
 * @returns {number} scale [0..1] relative to image height
 */
export function projectScale(itemHeightMetres, depthMetres, camera) {
  const tanHalfFovY = Math.tan(camera.fovY / 2);
  return itemHeightMetres / (2 * depthMetres * tanHalfFovY);
}

// ---------------------------------------------------------------------------
// Floor plan coordinate helpers
// ---------------------------------------------------------------------------

/**
 * Convert a floor plan canvas position (pixels) to world-space metres.
 * The floor plan editor works in pixel space; this converts back to the
 * same coordinate system as the camera poses.
 *
 * @param {{ x: number, y: number }} canvasPos  - pixel position on the canvas
 * @param {{ width: number, height: number }} canvasSize
 * @param {{ width: number, depth: number }} roomDimensions
 * @returns {{ x: number, z: number }}
 */
export function canvasToWorld(canvasPos, canvasSize, roomDimensions) {
  return {
    x: (canvasPos.x / canvasSize.width  - 0.5) * roomDimensions.width,
    z: (canvasPos.y / canvasSize.height - 0.5) * roomDimensions.depth,
  };
}

/**
 * Convert world-space metres to floor plan canvas pixels.
 * @param {{ x: number, z: number }} worldPos
 * @param {{ width: number, height: number }} canvasSize
 * @param {{ width: number, depth: number }} roomDimensions
 * @returns {{ x: number, y: number }}
 */
export function worldToCanvas(worldPos, canvasSize, roomDimensions) {
  return {
    x: (worldPos.x / roomDimensions.width  + 0.5) * canvasSize.width,
    y: (worldPos.z / roomDimensions.depth  + 0.5) * canvasSize.height,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _validateImageBlasterShape(raw) {
  const required = ['camera_poses', 'floor_plane', 'bounding_box'];
  for (const key of required) {
    if (!raw[key]) throw new Error(`Invalid image-blaster output: missing "${key}"`);
  }
}

function _extractFloorY(floorPlane) {
  // floor_plane: { normal: [nx,ny,nz], offset: d }  →  plane equation: n·x = d
  // For a horizontal floor (normal ≈ Y), floor Y = offset / ny
  const [, ny] = floorPlane.normal;
  return ny !== 0 ? floorPlane.offset / ny : 0;
}

function _vecFromArray([x, y, z]) {
  return { x, y, z };
}

function _parseCameraPose(cp) {
  // image-blaster stores camera-to-world (c2w) as a nested 4x4 array
  const c2w = cp.transform_matrix.flat();
  const w2c = _invertMat4(c2w);

  const fovY = _focalToFov(cp.fl_y, cp.height);

  return {
    photoId: cp.image.split('/').pop(),
    worldToCamera: w2c,
    cameraToWorld: c2w,
    fovY,
    aspectRatio: cp.width / cp.height,
    imageSize: { width: cp.width, height: cp.height },
  };
}

function _focalToFov(focalLengthPx, heightPx) {
  return 2 * Math.atan(heightPx / (2 * focalLengthPx));
}

function _extractRoomDimensions(bbox) {
  return {
    width:  bbox.max[0] - bbox.min[0],
    depth:  bbox.max[2] - bbox.min[2],
    height: bbox.max[1] - bbox.min[1],
  };
}

function _deriveFloorPolygonFromBBox(bbox) {
  const [minX,, minZ] = bbox.min;
  const [maxX,, maxZ] = bbox.max;
  return [
    { x: minX, y: minZ },
    { x: maxX, y: minZ },
    { x: maxX, y: maxZ },
    { x: minX, y: maxZ },
  ];
}

function _estimateFloorPolygonFromCameras(cameras) {
  // Rough bounding box from camera positions
  const positions = cameras.map(c => ({
    x: c.cameraToWorld[12],
    z: c.cameraToWorld[14],
  }));
  const xs = positions.map(p => p.x);
  const zs = positions.map(p => p.z);
  const pad = 1.0;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad;
  return [
    { x: minX, y: minZ },
    { x: maxX, y: minZ },
    { x: maxX, y: maxZ },
    { x: minX, y: maxZ },
  ];
}

function _estimateDimensionsFromCameras(cameras) {
  const positions = cameras.map(c => ({
    x: c.cameraToWorld[12],
    z: c.cameraToWorld[14],
  }));
  const xs = positions.map(p => p.x);
  const zs = positions.map(p => p.z);
  const pad = 1.0;
  return {
    width:  Math.max(...xs) - Math.min(...xs) + pad * 2,
    depth:  Math.max(...zs) - Math.min(...zs) + pad * 2,
    height: 2.6,
  };
}

// --- Matrix math (column-major, same as Three.js / WebGL) ---

function _transformPoint(p, m) {
  const x = m[0]*p.x + m[4]*p.y + m[8]*p.z  + m[12];
  const y = m[1]*p.x + m[5]*p.y + m[9]*p.z  + m[13];
  const z = m[2]*p.x + m[6]*p.y + m[10]*p.z + m[14];
  const w = m[3]*p.x + m[7]*p.y + m[11]*p.z + m[15];
  return { x: x/w, y: y/w, z: z/w };
}

function _invertMat4(m) {
  // Standard 4x4 matrix inverse (Gauss-Jordan)
  const out = new Array(16).fill(0);
  const a = m;

  const b00 = a[0]*a[5]  - a[1]*a[4];
  const b01 = a[0]*a[6]  - a[2]*a[4];
  const b02 = a[0]*a[7]  - a[3]*a[4];
  const b03 = a[1]*a[6]  - a[2]*a[5];
  const b04 = a[1]*a[7]  - a[3]*a[5];
  const b05 = a[2]*a[7]  - a[3]*a[6];
  const b06 = a[8]*a[13] - a[9]*a[12];
  const b07 = a[8]*a[14] - a[10]*a[12];
  const b08 = a[8]*a[15] - a[11]*a[12];
  const b09 = a[9]*a[14] - a[10]*a[13];
  const b10 = a[9]*a[15] - a[11]*a[13];
  const b11 = a[10]*a[15]- a[11]*a[14];

  const det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
  if (!det) throw new Error('Matrix is not invertible');
  const invDet = 1 / det;

  out[0]  = ( a[5]*b11 - a[6]*b10 + a[7]*b09) * invDet;
  out[1]  = (-a[1]*b11 + a[2]*b10 - a[3]*b09) * invDet;
  out[2]  = ( a[13]*b05- a[14]*b04+ a[15]*b03) * invDet;
  out[3]  = (-a[9]*b05 + a[10]*b04- a[11]*b03) * invDet;
  out[4]  = (-a[4]*b11 + a[6]*b08 - a[7]*b07) * invDet;
  out[5]  = ( a[0]*b11 - a[2]*b08 + a[3]*b07) * invDet;
  out[6]  = (-a[12]*b05+ a[14]*b02- a[15]*b01) * invDet;
  out[7]  = ( a[8]*b05 - a[10]*b02+ a[11]*b01) * invDet;
  out[8]  = ( a[4]*b10 - a[5]*b08 + a[7]*b06) * invDet;
  out[9]  = (-a[0]*b10 + a[1]*b08 - a[3]*b06) * invDet;
  out[10] = ( a[12]*b04- a[13]*b02+ a[15]*b00) * invDet;
  out[11] = (-a[8]*b04 + a[9]*b02 - a[11]*b00) * invDet;
  out[12] = (-a[4]*b09 + a[5]*b07 - a[6]*b06) * invDet;
  out[13] = ( a[0]*b09 - a[1]*b07 + a[2]*b06) * invDet;
  out[14] = (-a[12]*b03+ a[13]*b01- a[14]*b00) * invDet;
  out[15] = ( a[8]*b03 - a[9]*b01 + a[10]*b00) * invDet;

  return out;
}

function _lookAtMat4(eye, target, up) {
  const z = _normalize(_sub3(eye, target));
  const x = _normalize(_cross3(up, z));
  const y = _cross3(z, x);
  return [
    x.x, y.x, z.x, 0,
    x.y, y.y, z.y, 0,
    x.z, y.z, z.z, 0,
    -_dot3(x, eye), -_dot3(y, eye), -_dot3(z, eye), 1,
  ];
}

function _colmapQvecTvecToMat4(qvec, tvec) {
  // COLMAP qvec = [qw, qx, qy, qz], world-to-camera rotation
  const [qw, qx, qy, qz] = qvec;
  const [tx, ty, tz] = tvec;

  // Rotation matrix from quaternion
  const r00 = 1 - 2*(qy*qy + qz*qz);
  const r01 = 2*(qx*qy - qz*qw);
  const r02 = 2*(qx*qz + qy*qw);
  const r10 = 2*(qx*qy + qz*qw);
  const r11 = 1 - 2*(qx*qx + qz*qz);
  const r12 = 2*(qy*qz - qx*qw);
  const r20 = 2*(qx*qz - qy*qw);
  const r21 = 2*(qy*qz + qx*qw);
  const r22 = 1 - 2*(qx*qx + qy*qy);

  // COLMAP gives world-to-camera; invert to get camera-to-world
  const w2c = [
    r00, r10, r20, 0,
    r01, r11, r21, 0,
    r02, r12, r22, 0,
    tx,  ty,  tz,  1,
  ];
  return _invertMat4(w2c);
}

function _sub3(a, b) { return { x: a.x-b.x, y: a.y-b.y, z: a.z-b.z }; }
function _dot3(a, b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
function _cross3(a, b) {
  return { x: a.y*b.z-a.z*b.y, y: a.z*b.x-a.x*b.z, z: a.x*b.y-a.y*b.x };
}
function _normalize(v) {
  const l = Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z);
  return l > 0 ? { x: v.x/l, y: v.y/l, z: v.z/l } : v;
}

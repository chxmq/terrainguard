/**
 * Globe3D controller — keyless Cesium 3D globe.
 * CesiumJS (Apache-2.0) loads from the local build via vite-plugin-cesium
 * (no CDN or Cesium ion token). TTCI is draped on the relief built from our DEM.
 */

import { msaClearanceColor } from "@/lib/utils";

declare global {
  interface Window { Cesium: any; CESIUM_BASE_URL: string }
}

/** Injected by vite-plugin-cesium in dev; production HTML also sets window.CESIUM_BASE_URL. */
declare const CESIUM_BASE_URL: string | undefined;

let cesiumLoadPromise: Promise<void> | null = null;

function resolveCesiumBaseUrl(): string {
  if (typeof CESIUM_BASE_URL === "string" && CESIUM_BASE_URL.length > 0) {
    return CESIUM_BASE_URL;
  }
  if (typeof window !== "undefined" && window.CESIUM_BASE_URL) {
    return window.CESIUM_BASE_URL;
  }
  return "/cesium/";
}

export interface Region { south: number; north: number; west: number; east: number; zoom: number; source?: string }

export interface RouteWaypoint { lat: number; lon: number }
export interface RouteSector { sector: number; msa_ft: number; ttci: number | null }
export interface FlyPos { lat: number; lon: number; clearance_ft: number; heading_deg: number }
export interface TawsPoint { lat: number; lon: number; clearance_ft: number }
export interface MapViewPose { lat: number; lon: number; zoom: number }

const AIRCRAFT_MODEL_URL = "/models/Cesium_Air.glb";
const FT_TO_M = 0.3048;
/** Max camera height above the ellipsoid (~whole-Earth view). */
const MAX_CAMERA_HEIGHT_M = 18_000_000;
/** Min camera height scales with terrain exaggeration. */
const MIN_CAMERA_HEIGHT_BASE_M = 1_200;
/** Chase-cam standoff from the aircraft (meters). */
const CHASE_CAMERA_RANGE_M = 32_000;
const CHASE_CAMERA_PITCH_DEG = -24;

export function preloadCesium(): void {
  loadCesium().catch(() => { /* 3D is optional; 2D map must still work */ });
}

function loadCesium(): Promise<void> {
  if (window.Cesium) return Promise.resolve();
  cesiumLoadPromise ??= new Promise((resolve, reject) => {
    const base = resolveCesiumBaseUrl();
    window.CESIUM_BASE_URL = base;

    const existing = document.querySelector<HTMLScriptElement>('script[data-cesium-loader="1"]');
    if (existing) {
      if (window.Cesium) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Cesium")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.dataset.cesiumLoader = "1";
    script.src = `${base}Cesium.js`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Cesium"));
    document.head.appendChild(script);
  });
  return cesiumLoadPromise;
}

function ttciToColor(ttci: number | null): string {
  if (ttci == null) return "#888";
  if (ttci < 0.2) return "#2ecc71";
  if (ttci < 0.4) return "#f1c40f";
  if (ttci < 0.6) return "#e67e22";
  if (ttci < 0.8) return "#e74c3c";
  return "#8e44ad";
}

export class Globe3DController {
  private viewer: any = null;
  private region: Region | null = null;
  private grid: { rows: number; cols: number; bounds: any; elevMin: number; elevMax: number; elev: number[][] } | null = null;
  private ttciLayer: any = null;
  private cfit: any[] = [];
  private routeEntities: any[] = [];
  private flyEntity: any = null;
  private tawsEntities: any[] = [];
  private exaggeration = 3.0;
  private overlayOpacity = 0.72;
  private showOverlay = true;
  private tracking = false;
  private lastFlyPos: FlyPos | null = null;
  private cameraClampRemove: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeRemove: (() => void) | null = null;
  onHint?: (text: string | null) => void;

  constructor(private container: HTMLElement) {}

  private hint(t: string | null) { this.onHint?.(t); }

  private sampleMeters(lat: number, lon: number): number {
    const g = this.grid;
    if (!g) return 0;
    const b = g.bounds;
    if (lon < b.west || lon > b.east || lat < b.south || lat > b.north) return 0;
    const fx = (lon - b.west) / (b.east - b.west);
    const fy = (b.north - lat) / (b.north - b.south);
    let c = Math.round(fx * (g.cols - 1)), r = Math.round(fy * (g.rows - 1));
    c = Math.max(0, Math.min(c, g.cols - 1)); r = Math.max(0, Math.min(r, g.rows - 1));
    return g.elevMin + g.elev[r][c] * (g.elevMax - g.elevMin);
  }

  private makeTerrain() {
    const C = window.Cesium;
    const W = 32, H = 32;
    const tiling = new C.GeographicTilingScheme();
    return new C.CustomHeightmapTerrainProvider({
      width: W, height: H, tilingScheme: tiling,
      callback: (x: number, y: number, level: number) => {
        const rect = tiling.tileXYToRectangle(x, y, level);
        const heights = new Float64Array(W * H);
        for (let j = 0; j < H; j++) {
          const lat = C.Math.toDegrees(C.Math.lerp(rect.north, rect.south, j / (H - 1)));
          for (let i = 0; i < W; i++) {
            const lon = C.Math.toDegrees(C.Math.lerp(rect.west, rect.east, i / (W - 1)));
            heights[j * W + i] = this.sampleMeters(lat, lon) * this.exaggeration;
          }
        }
        return heights;
      },
    });
  }

  private initViewer() {
    const C = window.Cesium;
    this.viewer = new C.Viewer(this.container, {
      baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
      navigationHelpButton: false, sceneModePicker: false, animation: false,
      timeline: false, fullscreenButton: false, infoBox: true, selectionIndicator: true,
      creditContainer: document.createElement("div"),
    });
    // Esri World Imagery — real satellite photos, globally available, no token needed.
    this.viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
      url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maximumLevel: 19,
      credit: "Esri, Maxar, Earthstar Geographics",
    }));
    // Always show terrain at full brightness — no solar angle darkening.
    this.viewer.scene.globe.enableLighting = false;
    this.viewer.scene.globe.depthTestAgainstTerrain = true;
    this.viewer.scene.fog.enabled = false;
    this.viewer.scene.skyAtmosphere.show = true;
    this.configureCamera();
    this.bindCameraClamp();
    this.bindResize();
  }

  private bindResize() {
    this.unbindResize();
    const resize = () => this.resize();
    const ro = new ResizeObserver(resize);
    ro.observe(this.container);
    window.addEventListener("resize", resize);
    this.resizeObserver = ro;
    this.resizeRemove = () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
    };
    resize();
  }

  private unbindResize() {
    if (this.resizeRemove) {
      this.resizeRemove();
      this.resizeRemove = null;
    }
    this.resizeObserver = null;
  }

  /** Keep the Cesium canvas matched to the map pane (sidebar open/close, window resize). */
  resize() {
    if (!this.viewer || this.viewer.isDestroyed?.()) return;
    try {
      this.viewer.resize();
      this.viewer.scene.requestRender();
    } catch { /* noop */ }
  }

  private minCameraHeight(): number {
    return MIN_CAMERA_HEIGHT_BASE_M * Math.max(this.exaggeration, 1);
  }

  private configureCamera() {
    const C = window.Cesium;
    const ctrl = this.viewer.scene.screenSpaceCameraController;
    const minDist = this.minCameraHeight();

    ctrl.enableCollisionDetection = true;
    ctrl.minimumCollisionTerrainHeight = 4;
    ctrl.minimumZoomDistance = minDist;
    ctrl.maximumZoomDistance = MAX_CAMERA_HEIGHT_M;

    // Gentler wheel zoom — less “rocket into the ground / into space”.
    ctrl.zoomFactor = 2.2;
    ctrl.inertiaZoom = 0.35;
    ctrl.inertiaSpin = 0.55;
    ctrl.inertiaTranslate = 0.65;

    // Keep the horizon above the camera — prevents diving under the globe.
    if ("minimumPitch" in ctrl) {
      ctrl.minimumPitch = C.Math.toRadians(-82);
      ctrl.maximumPitch = C.Math.toRadians(-12);
    }
  }

  private bindCameraClamp() {
    if (this.cameraClampRemove) {
      this.cameraClampRemove();
      this.cameraClampRemove = null;
    }
    const clamp = () => this.clampCamera();
    this.viewer.camera.moveEnd.addEventListener(clamp);
    this.cameraClampRemove = () => this.viewer.camera.moveEnd.removeEventListener(clamp);
    clamp();
  }

  private clampCamera() {
    if (!this.viewer || !window.Cesium || this.tracking) return;
    const C = window.Cesium;
    const carto = this.viewer.camera.positionCartographic;
    const minH = this.minCameraHeight();
    const maxH = MAX_CAMERA_HEIGHT_M;
    if (carto.height >= minH && carto.height <= maxH) return;

    this.viewer.camera.setView({
      destination: C.Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        Math.min(maxH, Math.max(minH, carto.height)),
      ),
      orientation: {
        heading: this.viewer.camera.heading,
        pitch: this.viewer.camera.pitch,
        roll: this.viewer.camera.roll,
      },
    });
  }

  private earthBoundingSphere() {
    const C = window.Cesium;
    return new C.BoundingSphere(C.Cartesian3.ZERO, C.Ellipsoid.WGS84.maximumRadius);
  }

  /** Whole-Earth view with the planet centered in the viewport. */
  private flyToDefaultGlobeView(duration = 1.0) {
    const C = window.Cesium;
    const earth = this.earthBoundingSphere();
    this.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    this.viewer.camera.flyToBoundingSphere(earth, {
      duration,
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-58), earth.radius * 2.55),
    });
  }

  /** Point under the center of the screen (terrain hit or ellipsoid fallback). */
  private viewCenterOnGlobe(): any | null {
    const C = window.Cesium;
    const scene = this.viewer.scene;
    const canvas = scene.canvas;
    const center = new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ray = this.viewer.camera.getPickRay(center);
    if (!ray) return null;

    const hit = scene.globe.pick(ray, scene);
    if (hit) return hit;

    const intersection = C.IntersectionTests.rayEllipsoid(ray, scene.globe.ellipsoid);
    if (!intersection) return null;
    return C.Ray.getPoint(ray, intersection.start);
  }

  /**
   * Fix an inverted or rolled camera: north-up, level horizon, same approximate focus.
   * Stops aircraft tracking so manual controls work again.
   */
  repositionView() {
    if (!this.viewer || !window.Cesium) return;
    const C = window.Cesium;
    this.resize();
    this.setTracking(false);

    const height = this.viewer.camera.positionCartographic.height;
    if (height > 8_000_000) {
      this.flyToDefaultGlobeView(0.85);
      return;
    }

    const target = this.viewCenterOnGlobe();
    if (target) {
      const dist = C.Cartesian3.distance(this.viewer.camera.positionWC, target);
      const range = Math.min(
        MAX_CAMERA_HEIGHT_M * 0.85,
        Math.max(this.minCameraHeight() * 2, dist),
      );
      this.viewer.camera.flyToBoundingSphere(
        new C.BoundingSphere(target, 1),
        {
          duration: 0.85,
          offset: new C.HeadingPitchRange(0, C.Math.toRadians(-38), range),
        },
      );
      return;
    }

    const carto = this.viewer.camera.positionCartographic;
    const cameraHeight = Math.min(
      MAX_CAMERA_HEIGHT_M,
      Math.max(this.minCameraHeight(), carto.height),
    );
    this.viewer.camera.flyTo({
      destination: C.Cartesian3.fromRadians(carto.longitude, carto.latitude, cameraHeight),
      orientation: {
        heading: 0,
        pitch: C.Math.toRadians(-38),
        roll: 0,
      },
      duration: 0.85,
    });
  }

  /** Re-center on the active region or a comfortable whole-globe view. */
  resetView() {
    if (!this.viewer || !window.Cesium) return;
    this.resize();
    this.setTracking(false);
    if (this.region) this.flyToRegion(1.2);
    else this.flyToDefaultGlobeView(1.2);
  }

  /**
   * Cinematic camera move when entering 3D from the 2D map.
   * Uses the current map center/zoom when available, otherwise frames the active region.
   */
  animateEnterView(mapPose?: MapViewPose | null) {
    if (!this.viewer || !window.Cesium) return;
    this.resize();
    this.setTracking(false);
    const C = window.Cesium;
    this.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);

    if (mapPose && this.poseInActiveRegion(mapPose.lat, mapPose.lon)) {
      this.flyToMapPose(mapPose, 1.25);
      return;
    }
    if (this.region) {
      this.flyToRegion(1.35);
      return;
    }
    if (mapPose) {
      this.flyToMapPose(mapPose, 1.25);
      return;
    }
    this.flyToDefaultGlobeView(1.1);
  }

  private poseInActiveRegion(lat: number, lon: number): boolean {
    const b = this.region;
    if (!b) return false;
    return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
  }

  private heightFromMapZoom(zoom: number): number {
    const z = Math.max(2, Math.min(14, zoom));
    if (z <= 4) return 14_000_000;
    if (z <= 6) return 4_500_000;
    if (z <= 8) return 1_200_000;
    if (z <= 10) return 280_000;
    if (z <= 12) return 72_000;
    return Math.max(this.minCameraHeight() * 2, 28_000);
  }

  private flyToMapPose(pose: MapViewPose, duration: number) {
    const C = window.Cesium;
    const height = Math.min(
      MAX_CAMERA_HEIGHT_M * 0.9,
      Math.max(this.minCameraHeight() * 1.5, this.heightFromMapZoom(pose.zoom)),
    );
    this.viewer.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(pose.lon, pose.lat, height),
      orientation: {
        heading: 0,
        pitch: C.Math.toRadians(-38),
        roll: 0,
      },
      duration,
    });
  }

  async open(region: Region | null) {
    this.hint("Loading 3D globe…");
    await loadCesium();
    if (!this.viewer) this.initViewer();
    if (region) await this.loadRegion(region);
    else {
      this.flyToDefaultGlobeView(0);
      this.hint(null);
    }
  }

  async loadRegion(region: Region) {
    const C = window.Cesium;
    this.hint("Computing terrain for this region…");
    const src = region.source || "tiles";
    const url = `/api/region/grid?south=${region.south}&north=${region.north}&west=${region.west}&east=${region.east}&zoom=${region.zoom}&source=${encodeURIComponent(src)}&rows=256&cols=256`;
    const res = await fetch(url);
    if (!res.ok) { this.hint("Failed to load terrain for this region."); return; }
    const data = await res.json();
    this.grid = { rows: data.rows, cols: data.cols, bounds: data.bounds, elevMin: data.elev_min, elevMax: data.elev_max, elev: data.elevation };
    this.region = { ...region, ...data.bounds };
    try { this.viewer.terrainProvider = this.makeTerrain(); }
    catch { this.viewer.terrainProvider = new C.EllipsoidTerrainProvider(); }
    await this.drape();
    this.flyToRegion(1.8);
    this.hint(null);
  }

  private async drape() {
    const C = window.Cesium;
    if (this.ttciLayer) { this.viewer.imageryLayers.remove(this.ttciLayer, true); this.ttciLayer = null; }
    const b = this.region!;
    const src = b.source || "tiles";
    const url = `/api/region/overlay.png?south=${b.south}&north=${b.north}&west=${b.west}&east=${b.east}&zoom=${b.zoom}&source=${encodeURIComponent(src)}`;
    const rect = C.Rectangle.fromDegrees(b.west, b.south, b.east, b.north);
    const provider = await C.SingleTileImageryProvider.fromUrl(url, { rectangle: rect });
    this.ttciLayer = this.viewer.imageryLayers.addImageryProvider(provider);
    this.ttciLayer.alpha = this.overlayOpacity;
    this.ttciLayer.show = this.showOverlay;
  }

  setOverlaySettings(show: boolean, opacity: number) {
    this.showOverlay = show;
    this.overlayOpacity = opacity;
    if (this.ttciLayer) {
      this.ttciLayer.show = show;
      this.ttciLayer.alpha = opacity;
    }
  }

  private flyToRegion(duration = 1.8) {
    const C = window.Cesium;
    const b = this.region!;
    const rect = C.Rectangle.fromDegrees(b.west, b.south, b.east, b.north);
    const sphere = C.BoundingSphere.fromRectangle3D(rect);
    const r = Math.min(Math.max(sphere.radius, 80_000), 500_000);
    this.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration,
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-38), r * 2.4),
    });
  }

  /** Draw the flight route in 3D: polyline, waypoint markers, per-sector MSA labels. */
  updateRoute(
    waypoints: RouteWaypoint[],
    sectors: RouteSector[],
    options?: { flyCamera?: boolean },
  ) {
    if (!this.viewer || !window.Cesium) return;
    const C = window.Cesium;

    this.routeEntities.forEach(e => this.viewer.entities.remove(e));
    this.routeEntities = [];

    if (waypoints.length < 2) return;

    // Route polyline clamped to terrain
    this.routeEntities.push(this.viewer.entities.add({
      polyline: {
        positions: waypoints.map(w => C.Cartesian3.fromDegrees(w.lon, w.lat)),
        width: 4,
        material: new C.ColorMaterialProperty(C.Color.fromCssColorString("#60a5fa").withAlpha(0.92)),
        clampToGround: true,
      },
    }));

    // Waypoint markers
    waypoints.forEach((w, i) => {
      this.routeEntities.push(this.viewer.entities.add({
        position: C.Cartesian3.fromDegrees(w.lon, w.lat),
        point: {
          pixelSize: 11,
          color: C.Color.fromCssColorString("#3b82f6"),
          outlineColor: C.Color.WHITE,
          outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `WP${i + 1}`,
          font: '500 11px "Geist", system-ui, sans-serif',
          fillColor: C.Color.WHITE,
          showBackground: true,
          backgroundColor: C.Color.fromCssColorString("#0a0e1aCC"),
          backgroundPadding: new C.Cartesian2(4, 3),
          pixelOffset: new C.Cartesian2(0, -24),
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }));
    });

    // Per-sector MSA labels at midpoint of each leg
    sectors.forEach((s, i) => {
      if (i + 1 >= waypoints.length) return;
      const w1 = waypoints[i], w2 = waypoints[i + 1];
      this.routeEntities.push(this.viewer.entities.add({
        position: C.Cartesian3.fromDegrees((w1.lon + w2.lon) / 2, (w1.lat + w2.lat) / 2),
        label: {
          text: `S${s.sector}  MSA ${Math.round(s.msa_ft).toLocaleString()} ft`,
          font: 'bold 12px "JetBrains Mono", monospace',
          fillColor: C.Color.fromCssColorString("#93c5fd"),
          showBackground: true,
          backgroundColor: C.Color.fromCssColorString("#0a0e1add"),
          backgroundPadding: new C.Cartesian2(6, 4),
          pixelOffset: new C.Cartesian2(0, -44),
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new C.NearFarScalar(4.0e4, 1.0, 2.5e6, 0.3),
        },
      }));
    });

    if (options?.flyCamera) {
      const positions = waypoints.map((w) => C.Cartesian3.fromDegrees(w.lon, w.lat));
      const sphere = C.BoundingSphere.fromPoints(positions);
      const r = Math.min(Math.max(sphere.radius, 80_000), 500_000);
      this.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
      this.viewer.camera.flyToBoundingSphere(sphere, {
        duration: 1.5,
        offset: new C.HeadingPitchRange(0, C.Math.toRadians(-38), r * 2.4),
      });
    }
  }

  private aircraftWorldPosition(pos: FlyPos): { position: any; aglM: number; terrainM: number } {
    const C = window.Cesium;
    const terrainM = this.sampleMeters(pos.lat, pos.lon) * this.exaggeration;
    const aglM = Math.max(pos.clearance_ft, 800) * FT_TO_M * this.exaggeration;
    const position = C.Cartesian3.fromDegrees(pos.lon, pos.lat, terrainM + aglM);
    return { position, aglM, terrainM };
  }

  private updateChaseCamera(pos: FlyPos, position: any) {
    const C = window.Cesium;
    this.viewer.trackedEntity = undefined;
    const range = Math.max(
      CHASE_CAMERA_RANGE_M,
      this.minCameraHeight() * 4 + this.exaggeration * 8_000,
    );
    this.viewer.camera.lookAt(
      position,
      new C.HeadingPitchRange(
        C.Math.toRadians(pos.heading_deg),
        C.Math.toRadians(CHASE_CAMERA_PITCH_DEG),
        range,
      ),
    );
  }

  /** Move (or create) the animated 3-D aircraft model following the flight. */
  updateFlyAircraft(pos: FlyPos | null) {
    if (!this.viewer || !window.Cesium) return;
    const C = window.Cesium;

    if (!pos) {
      this.lastFlyPos = null;
      if (this.flyEntity) {
        this.viewer.entities.remove(this.flyEntity);
        this.flyEntity = null;
      }
      return;
    }

    this.lastFlyPos = pos;
    const { position } = this.aircraftWorldPosition(pos);
    const hpr = new C.HeadingPitchRoll(C.Math.toRadians(pos.heading_deg - 90), 0, 0);
    const orientation = C.Transforms.headingPitchRollQuaternion(position, hpr);
    const tint = C.Color.fromCssColorString(msaClearanceColor(pos.clearance_ft));

    if (!this.flyEntity) {
      this.flyEntity = this.viewer.entities.add({
        position,
        orientation,
        model: {
          uri: AIRCRAFT_MODEL_URL,
          minimumPixelSize: 64,
          maximumScale: 12_000,
          color: tint,
          colorBlendMode: C.ColorBlendMode.MIX,
          colorBlendAmount: 0.45,
          silhouetteColor: C.Color.WHITE,
          silhouetteSize: 2.0,
          heightReference: C.HeightReference.NONE,
        },
      });
    } else {
      this.flyEntity.position = position;
      this.flyEntity.orientation = orientation;
      this.flyEntity.model.color = tint;
    }

    if (this.tracking) {
      this.updateChaseCamera(pos, position);
    }
  }

  /** Draw the TAWS look-ahead path as colored polyline segments in 3D. */
  updateTawsPath(origin: RouteWaypoint | null, profile: TawsPoint[]) {
    if (!this.viewer || !window.Cesium) return;
    const C = window.Cesium;

    this.tawsEntities.forEach(e => this.viewer.entities.remove(e));
    this.tawsEntities = [];

    if (!origin || profile.length === 0) return;

    let prev = origin;
    profile.forEach(p => {
      this.tawsEntities.push(this.viewer.entities.add({
        polyline: {
          positions: [
            C.Cartesian3.fromDegrees(prev.lon, prev.lat),
            C.Cartesian3.fromDegrees(p.lon, p.lat),
          ],
          width: 3,
          material: new C.ColorMaterialProperty(
            C.Color.fromCssColorString(msaClearanceColor(p.clearance_ft)).withAlpha(0.88),
          ),
          clampToGround: true,
        },
      }));
      prev = p;
    });
  }

  /** Enable/disable manual chase camera (does not use Cesium trackedEntity zoom). */
  setTracking(on: boolean) {
    this.tracking = on;
    if (!this.viewer || !window.Cesium) return;
    const C = window.Cesium;
    this.viewer.trackedEntity = undefined;
    if (!on) {
      this.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
      return;
    }
    if (this.lastFlyPos && this.flyEntity?.position) {
      const world = this.flyEntity.position.getValue(this.viewer.clock.currentTime);
      if (world) this.updateChaseCamera(this.lastFlyPos, world);
    }
  }

  /** Toggle camera tracking of the fly aircraft. Returns new tracking state. */
  toggleTrackAircraft(): boolean {
    this.setTracking(!this.tracking);
    return this.tracking;
  }

  async setCFITVisible(show: boolean): Promise<"shown" | "hidden" | "empty"> {
    if (!this.viewer || !window.Cesium) return "empty";
    const C = window.Cesium;
    if (!show) {
      if (this.cfit.length) {
        this.cfit.forEach((e) => this.viewer.entities.remove(e));
        this.cfit = [];
      }
      return "hidden";
    }
    if (this.cfit.length) return "shown";
    const res = await fetch("/api/validation");
    if (!res.ok) return "empty";
    const data = await res.json();
    data.accidents.forEach((a: any) => {
      const ent = this.viewer.entities.add({
        position: C.Cartesian3.fromDegrees(a.lon, a.lat),
        point: {
          pixelSize: 11, color: C.Color.fromCssColorString(a.risk_color),
          outlineColor: C.Color.WHITE, outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: a.flight, font: '500 12px "Geist", system-ui, sans-serif', fillColor: C.Color.WHITE,
          showBackground: true, backgroundColor: C.Color.fromCssColorString("#0a0e1aDD"),
          pixelOffset: new C.Cartesian2(0, -18),
          scaleByDistance: new C.NearFarScalar(1.0e5, 1.0, 5.0e6, 0.5),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        description:
          `<table class="cesium-infobox-defaultTable"><tbody>` +
          `<tr><th>Date</th><td>${a.date}</td></tr>` +
          `<tr><th>Site</th><td>${a.site}, ${a.country}</td></tr>` +
          `<tr><th>Fatalities</th><td>${a.fatalities}</td></tr>` +
          `<tr><th>TTCI</th><td>${a.site_ttci} (${a.risk_level})</td></tr>` +
          `</tbody></table><p><a href="${a.source}" target="_blank" rel="noopener">Accident report ↗</a></p>`,
      });
      this.cfit.push(ent);
    });
    this.flyToDefaultGlobeView(1.5);
    return "shown";
  }

  setExaggeration(v: number) {
    this.exaggeration = v || 1;
    if (this.viewer) {
      this.configureCamera();
      if (this.grid) {
        try { this.viewer.terrainProvider = this.makeTerrain(); } catch { /* noop */ }
      }
      this.clampCamera();
    }
  }

  viewCenter(): { lat: number; lon: number } | null {
    if (!this.viewer || !window.Cesium) return null;
    const C = window.Cesium;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return null;
    const c = C.Rectangle.center(rect);
    return { lat: C.Math.toDegrees(c.latitude), lon: C.Math.toDegrees(c.longitude) };
  }

  /** Rough Leaflet zoom level matching the current globe camera height. */
  viewZoom(): number {
    if (!this.viewer || !window.Cesium) return 9;
    const height = this.viewer.camera.positionCartographic.height;
    if (height > 20_000_000) return 4;
    if (height > 5_000_000) return 6;
    if (height > 1_000_000) return 8;
    if (height > 200_000) return 10;
    if (height > 50_000) return 12;
    return 13;
  }

  viewPose(): { lat: number; lon: number; zoom: number } | null {
    const center = this.viewCenter();
    if (!center) return null;
    return { ...center, zoom: this.viewZoom() };
  }

  destroy() {
    this.unbindResize();
    if (this.cameraClampRemove) {
      this.cameraClampRemove();
      this.cameraClampRemove = null;
    }
    try { this.viewer?.destroy(); } catch { /* noop */ }
    this.viewer = null;
  }
}

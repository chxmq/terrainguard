/**
 * Globe3D controller — keyless Cesium 3D globe.
 * CesiumJS (Apache-2.0) is lazy-loaded from CDN; base imagery is CARTO tiles and
 * the 3D relief is built from our own DEM via a CustomHeightmapTerrainProvider,
 * so no Cesium ion token is ever used. TTCI is draped on the relief.
 */

import { msaClearanceColor } from "@/lib/utils";

declare global {
  interface Window { Cesium: any; CESIUM_BASE_URL: string }
}

const CESIUM_VERSION = "1.111";
const CESIUM_BASE = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/`;

export interface Region { south: number; north: number; west: number; east: number; zoom: number; source?: string }

export interface RouteWaypoint { lat: number; lon: number }
export interface RouteSector { sector: number; msa_ft: number; ttci: number | null }
export interface FlyPos { lat: number; lon: number; clearance_ft: number; heading_deg: number }
export interface TawsPoint { lat: number; lon: number; clearance_ft: number }

// Classic Cesium sample aircraft (glTF). GitHub raw serves it with permissive
// CORS, so it loads cross-origin without any token or local asset.
const AIRCRAFT_MODEL_URL =
  "https://raw.githubusercontent.com/CesiumGS/cesium/1.111/Apps/SampleData/models/CesiumAir/Cesium_Air.glb";
const FT_TO_M = 0.3048;

let loadingPromise: Promise<void> | null = null;
export function preloadCesium(): void {
  loadCesium().catch(() => {});
}

function loadCesium(): Promise<void> {
  if (window.Cesium) return Promise.resolve();
  if (loadingPromise) return loadingPromise;
  window.CESIUM_BASE_URL = CESIUM_BASE;
  loadingPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = `${CESIUM_BASE}Widgets/widgets.css`;
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = `${CESIUM_BASE}Cesium.js`;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load CesiumJS from CDN."));
    document.head.appendChild(s);
  });
  return loadingPromise;
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
  onHint?: (text: string | null) => void;

  constructor(private container: HTMLElement) {}

  private hint(t: string | null) { this.onHint?.(t); }

  private sampleMeters(lat: number, lon: number): number {
    const g = this.grid;
    if (!g) return 0;
    const b = g.bounds;

    // 1. Return 0 if completely outside the bounding box
    if (lon < b.west || lon > b.east || lat < b.south || lat > b.north) return 0;

    // Calculate a smooth boundary fade-out margin to avoid height discontinuities at the edges.
    // Use a small fraction (1%) of the region span, capped at 0.005 degrees.
    const wSpan = b.east - b.west;
    const hSpan = b.north - b.south;
    const marginX = Math.min(0.005, wSpan * 0.01);
    const marginY = Math.min(0.005, hSpan * 0.01);

    const dx = Math.min(lon - b.west, b.east - lon);
    const dy = Math.min(lat - b.south, b.north - lat);

    let fade = 1.0;
    if (dx < marginX) fade *= dx / marginX;
    if (dy < marginY) fade *= dy / marginY;

    // 2. Continuous bilinear interpolation of grid coordinates
    const fx = (lon - b.west) / wSpan;
    const fy = (b.north - lat) / hSpan;

    const xVal = fx * (g.cols - 1);
    const yVal = fy * (g.rows - 1);

    const c0 = Math.floor(xVal);
    const c1 = Math.min(c0 + 1, g.cols - 1);
    const r0 = Math.floor(yVal);
    const r1 = Math.min(r0 + 1, g.rows - 1);

    const tx = xVal - c0;
    const ty = yVal - r0;

    const h00 = g.elev[r0][c0];
    const h10 = g.elev[r0][c1];
    const h01 = g.elev[r1][c0];
    const h11 = g.elev[r1][c1];

    const h0 = h00 * (1 - tx) + h10 * tx;
    const h1 = h01 * (1 - tx) + h11 * tx;
    const hInterpolated = h0 * (1 - ty) + h1 * ty;

    const rawElev = g.elevMin + hInterpolated * (g.elevMax - g.elevMin);
    return rawElev * fade;
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
    const ctrl = this.viewer.scene.screenSpaceCameraController;
    ctrl.enableCollisionDetection = false;
    ctrl.minimumZoomDistance = 80;
    // Allow zooming all the way out to a whole-globe view so the worldwide CFIT
    // accident spread (flyHome) and free exploration both work; collision
    // detection is off so tall exaggerated terrain can't trap the camera.
    ctrl.maximumZoomDistance = 4.0e7;
  }

  async open(region: Region | null) {
    this.hint("Loading 3D globe…");
    await loadCesium();
    if (!this.viewer) this.initViewer();
    if (region) await this.loadRegion(region);
    else this.hint(null);
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
    this.flyTo();
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

  private flyTo() {
    const C = window.Cesium;
    const b = this.region!;
    const rect = C.Rectangle.fromDegrees(b.west, b.south, b.east, b.north);
    const sphere = C.BoundingSphere.fromRectangle3D(rect);
    // Clamp radius so small regions don't zoom in too tight and large ones don't
    // zoom out to globe-scale. Target range: 40 km – 600 km effective radius.
    const r = Math.min(Math.max(sphere.radius, 40_000), 600_000);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.8,
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-32), r * 2.0),
    });
  }

  /** Draw the flight route in 3D: polyline, waypoint markers, per-sector MSA labels. */
  updateRoute(waypoints: RouteWaypoint[], sectors: RouteSector[]) {
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
          font: "11px Inter, sans-serif",
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

    // Frame the route so drawing / calculating an MSA zooms the camera to the area.
    const positions = waypoints.map((w) => C.Cartesian3.fromDegrees(w.lon, w.lat));
    const sphere = C.BoundingSphere.fromPoints(positions);
    const r = Math.min(Math.max(sphere.radius, 30_000), 600_000);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.5,
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-35), r * 2.2),
    });
  }

  /** Move (or create) the animated 3-D aircraft model following the flight. */
  updateFlyAircraft(pos: FlyPos | null) {
    if (!this.viewer || !window.Cesium) return;
    const C = window.Cesium;

    if (!pos) {
      if (this.flyEntity) {
        if (this.tracking) { this.viewer.trackedEntity = undefined; this.tracking = false; }
        this.viewer.entities.remove(this.flyEntity);
        this.flyEntity = null;
      }
      return;
    }

    // Fly the aircraft at its clearance height above the (exaggerated) terrain,
    // so it visibly soars over the peaks rather than sitting on the ground.
    const aglM = Math.max(pos.clearance_ft, 0) * FT_TO_M * this.exaggeration;
    const position = C.Cartesian3.fromDegrees(pos.lon, pos.lat, aglM);
    // The glTF model's nose is +X (east); offset by -90° so it points along the
    // travel bearing (clockwise from north).
    const hpr = new C.HeadingPitchRoll(C.Math.toRadians(pos.heading_deg - 90), 0, 0);
    const orientation = C.Transforms.headingPitchRollQuaternion(position, hpr);
    const tint = C.Color.fromCssColorString(msaClearanceColor(pos.clearance_ft));

    if (!this.flyEntity) {
      this.flyEntity = this.viewer.entities.add({
        position,
        orientation,
        // Chase camera: ~9 km behind and 4.5 km above when tracking.
        viewFrom: new C.Cartesian3(0, -9000, 4500),
        model: {
          uri: AIRCRAFT_MODEL_URL,
          minimumPixelSize: 72,
          maximumScale: 60000,
          color: tint,
          colorBlendMode: C.ColorBlendMode.MIX,
          colorBlendAmount: 0.45,
          silhouetteColor: C.Color.WHITE,
          silhouetteSize: 2.0,
          heightReference: C.HeightReference.RELATIVE_TO_GROUND,
        },
      });
      if (this.tracking) this.viewer.trackedEntity = this.flyEntity;
    } else {
      this.flyEntity.position = position;
      this.flyEntity.orientation = orientation;
      this.flyEntity.model.color = tint;
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

  /** Toggle camera tracking of the fly aircraft. Returns new tracking state. */
  toggleTrackAircraft(): boolean {
    this.tracking = !this.tracking;
    if (this.viewer) {
      this.viewer.trackedEntity = this.tracking && this.flyEntity ? this.flyEntity : undefined;
    }
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
          text: a.flight, font: "12px Inter, sans-serif", fillColor: C.Color.WHITE,
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
    this.viewer.camera.flyHome(1.5);
    return "shown";
  }

  setExaggeration(v: number) {
    this.exaggeration = v || 1;
    if (this.viewer && this.grid) { try { this.viewer.terrainProvider = this.makeTerrain(); } catch { /* noop */ } }
  }

  viewCenter(): { lat: number; lon: number } | null {
    if (!this.viewer || !window.Cesium) return null;
    const C = window.Cesium;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return null;
    const c = C.Rectangle.center(rect);
    return { lat: C.Math.toDegrees(c.latitude), lon: C.Math.toDegrees(c.longitude) };
  }

  destroy() {
    try { this.viewer?.destroy(); } catch { /* noop */ }
    this.viewer = null;
  }
}

/**
 * Globe3D controller — keyless Cesium 3D globe.
 * CesiumJS (Apache-2.0) is lazy-loaded from CDN; base imagery is CARTO tiles and
 * the 3D relief is built from our own DEM via a CustomHeightmapTerrainProvider,
 * so no Cesium ion token is ever used. TTCI is draped on the relief.
 */

declare global {
  interface Window { Cesium: any; CESIUM_BASE_URL: string }
}

const CESIUM_VERSION = "1.111";
const CESIUM_BASE = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/`;

export interface Region { south: number; north: number; west: number; east: number; zoom: number }

let loadingPromise: Promise<void> | null = null;
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

export class Globe3DController {
  private viewer: any = null;
  private region: Region | null = null;
  private grid: { rows: number; cols: number; bounds: any; elevMin: number; elevMax: number; elev: number[][] } | null = null;
  private ttciLayer: any = null;
  private cfit: any[] = [];
  private exaggeration = 3.0;
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
    this.viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
      subdomains: "abcd", maximumLevel: 18, credit: "© OpenStreetMap, © CARTO",
    }));
    this.viewer.scene.globe.depthTestAgainstTerrain = true;
    const ctrl = this.viewer.scene.screenSpaceCameraController;
    ctrl.enableCollisionDetection = false;
    ctrl.minimumZoomDistance = 80;
    ctrl.maximumZoomDistance = 3.0e7;
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
    const url = `/api/region/grid?south=${region.south}&north=${region.north}&west=${region.west}&east=${region.east}&zoom=${region.zoom}&rows=256&cols=256`;
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
    const url = `/api/region/overlay.png?south=${b.south}&north=${b.north}&west=${b.west}&east=${b.east}&zoom=${b.zoom}`;
    const rect = C.Rectangle.fromDegrees(b.west, b.south, b.east, b.north);
    const provider = await C.SingleTileImageryProvider.fromUrl(url, { rectangle: rect });
    this.ttciLayer = this.viewer.imageryLayers.addImageryProvider(provider);
    this.ttciLayer.alpha = 0.78;
  }

  private flyTo() {
    const C = window.Cesium;
    const b = this.region!;
    const rect = C.Rectangle.fromDegrees(b.west, b.south, b.east, b.north);
    const sphere = C.BoundingSphere.fromRectangle3D(rect);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.8,
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-32), sphere.radius * 2.6),
    });
  }

  async toggleCFIT(): Promise<"shown" | "hidden" | "empty"> {
    const C = window.Cesium;
    if (this.cfit.length) {
      this.cfit.forEach((e) => this.viewer.entities.remove(e));
      this.cfit = [];
      return "hidden";
    }
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

"use client";

import { OrthographicCamera } from "@react-three/drei";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { useMemo, useEffect, useRef, useState } from "react";

import { createQuadGeometry, useFluid } from "./fluid-simulation";
import * as THREE from "three";

type ShaderEffectProps = {
  /** Text drawn as the mask (white on black). Single line works best. */
  maskText?: string;
};

/** OTF name table: family "Basement Grotesque Roman", subfamily Bold (not "Baseline Grotesque"). */
const BASEMENT_GROTESQUE_FAMILY = "Basement Grotesque Roman";

const BASEMENT_FONT_URLS = [
  "/fonts/basement-grotesque.otf",
  "/fonts/basement-grotesque.woff2",
  "/fonts/BasementGrotesque-Regular.woff2",
] as const;

/** Bump when font files or URL order changes (invalidates cached load promise in HMR). */
const BASEMENT_FONT_LOAD_KEY = 4;

/** One shared load per key so Strict Mode does not stack failing retries into system-ui. */
let basementFontLoad: Promise<string> | null = null;
let basementFontLoadKey = 0;

export function ShaderEffect({ maskText = "AURA" }: ShaderEffectProps) {
  return (
    <div className="absolute h-screen w-screen top-0 left-0 bg-black">
      <Canvas
        gl={{
          toneMapping: THREE.NoToneMapping,
        }}
      >
        <OrthographicCamera
          makeDefault
          position={[0, 0, 1]}
          left={-0.5}
          right={0.5}
          top={0.5}
          bottom={-0.5}
          near={0.1}
          far={2}
        />
        <Scene maskText={maskText} />
      </Canvas>
    </div>
  );
}

function createTextMaskTexture(
  text: string,
  fontFamily: string
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable");
  }

  const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio : 1);
  const fontSize = 720 * dpr;
  const pad = 6 * dpr;
  const font =
    fontFamily === "system-ui"
      ? `700 ${fontSize}px system-ui, sans-serif`
      : `700 ${fontSize}px "${fontFamily}", sans-serif`;

  ctx.font = font;
  const m = ctx.measureText(text);
  const ascent = m.actualBoundingBoxAscent ?? fontSize * 0.72;
  const descent = m.actualBoundingBoxDescent ?? fontSize * 0.28;
  const bl = m.actualBoundingBoxLeft ?? 0;
  const br = m.actualBoundingBoxRight ?? m.width;
  const textW = Math.max(m.width, bl + br);
  const w = Math.max(Math.ceil(textW + pad * 2), 8);
  const h = Math.max(Math.ceil(ascent + descent + pad * 2), 8);

  canvas.width = w;
  canvas.height = h;

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, w * 0.5, pad + ascent);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

async function loadBasementGrotesqueOnce(): Promise<string> {
  if (typeof document === "undefined") return "system-ui";

  for (const url of BASEMENT_FONT_URLS) {
    try {
      const face = new FontFace(BASEMENT_GROTESQUE_FAMILY, `url(${url})`);
      await face.load();
      document.fonts.add(face);
      await document.fonts.ready;
      return BASEMENT_GROTESQUE_FAMILY;
    } catch {
      /* try next path */
    }
  }
  return "system-ui";
}

function getBasementFontFamily(): Promise<string> {
  if (basementFontLoadKey !== BASEMENT_FONT_LOAD_KEY) {
    basementFontLoadKey = BASEMENT_FONT_LOAD_KEY;
    basementFontLoad = null;
  }
  if (!basementFontLoad) {
    basementFontLoad = loadBasementGrotesqueOnce();
  }
  return basementFontLoad;
}

function useBasementFontFamily() {
  const [family, setFamily] = useState("system-ui");

  useEffect(() => {
    let cancelled = false;
    getBasementFontFamily().then((f) => {
      if (!cancelled) setFamily(f);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return family;
}

function useTextMaskTexture(text: string, fontFamily: string) {
  const texture = useMemo(
    () => createTextMaskTexture(text, fontFamily),
    [text, fontFamily]
  );

  useEffect(() => {
    return () => {
      texture.dispose();
    };
  }, [texture]);

  return texture;
}

function Scene({ maskText }: { maskText: string }) {
  const fontFamily = useBasementFontFamily();
  const logo = useTextMaskTexture(maskText, fontFamily);

  const { velocity } = useFluid({
    simRes: 256,
    densityDissipation: 0.994,
    velocityDissipation: 0.995,
    curlStrength: 8,
    radius: 0.95,
  });
  const { size } = useThree();
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uVelocity: { value: null },
      uLogo: { value: logo },
      uBackgroundColor: { value: new THREE.Color("black") },
      uLogoAspect: { value: 1 },
      uResolution: { value: new THREE.Vector2(size.width, size.height) },
      uTime: { value: 0 },
      uVelWarp: { value: 0.016 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // update changes (must run before first paint — never leave uLogoAspect at 1 or layout flashes huge→small)
  uniforms.uLogo.value = logo;
  uniforms.uResolution.value.set(size.width, size.height);
  const maskCanvas = logo.image as HTMLCanvasElement;
  if (maskCanvas.width > 0 && maskCanvas.height > 0) {
    uniforms.uLogoAspect.value = maskCanvas.width / maskCanvas.height;
  }

  useFrame((state) => {
    if (materialRef.current && velocity.read.texture) {
      materialRef.current.uniforms.uVelocity.value = velocity.read.texture;
      materialRef.current.uniforms.uTime.value = state.clock.elapsedTime;
    }
  });

  return (
    <mesh geometry={quadGeometry}>
      <shaderMaterial
        toneMapped={false}
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
      />
    </mesh>
  );
}

const vertexShader = /*glsl*/ `
  precision highp float;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0, 1);
  }
`;

const fragmentShader = /*glsl*/ `
  precision highp float;
  uniform sampler2D uVelocity;
  uniform sampler2D uLogo;
  uniform vec3 uBackgroundColor;
  uniform float uLogoAspect;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uVelWarp;
  varying vec2 vUv;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  vec3 paletteAt(float fi) {
    if (fi < 0.5) return vec3(0.0, 0.070588, 0.098039);
    if (fi < 1.5) return vec3(0.0, 0.372549, 0.450980);
    if (fi < 2.5) return vec3(0.039216, 0.576471, 0.588235);
    if (fi < 3.5) return vec3(0.580392, 0.823529, 0.741176);
    if (fi < 4.5) return vec3(0.913725, 0.847059, 0.650980);
    if (fi < 5.5) return vec3(0.933333, 0.607843, 0.0);
    if (fi < 6.5) return vec3(0.792157, 0.403922, 0.007843);
    if (fi < 7.5) return vec3(0.733333, 0.243137, 0.011765);
    if (fi < 8.5) return vec3(0.682353, 0.125490, 0.070588);
    return vec3(0.607843, 0.133333, 0.149020);
  }

  vec3 paletteBlend(float t) {
    t = clamp(t, 0.0, 1.0);
    float u = t * 9.0;
    float i0 = floor(u);
    float i1 = min(i0 + 1.0, 9.0);
    float f = smoothstep(0.0, 1.0, fract(u));
    return mix(paletteAt(i0), paletteAt(i1), f);
  }

  float organicFlow(vec2 p, float time) {
    float s = time * 0.012;
    float a = sin(dot(p, vec2(0.22, 0.17)) + s) * 0.5 + 0.5;
    float b = sin(dot(p, vec2(-0.15, 0.21)) - s * 0.85) * 0.5 + 0.5;
    float c = sin(dot(p * 0.62, vec2(0.11, 0.13)) + s * 0.55) * 0.5 + 0.5;
    float d = sin(dot(p, vec2(0.08, 0.09)) + s * 0.35) * 0.5 + 0.5;
    return (a * 0.38 + b * 0.32 + c * 0.18 + d * 0.12);
  }

  float spreadT(float x) {
    return clamp(x * 1.25 - 0.08, 0.0, 1.0);
  }

  vec3 fluidPaintField(vec2 p, float time) {
    float g = organicFlow(p, time);
    float h = organicFlow(p * 1.04 + vec2(0.31, 0.22), time * 0.97);
    float k = organicFlow(p * 0.88 + vec2(0.07, 0.11), time * 0.88);
    float tBody = spreadT(g * 0.34 + h * 0.33 + k * 0.33);
    float tEdge = spreadT(min(min(g, h), k));
    float tRidge = spreadT(max(max(g, h), k));
    float tAlt = spreadT(organicFlow(p * 1.75 + vec2(0.52, 0.38), time * 1.05));
    float tWave = fract(time * 0.0065 + dot(p, vec2(0.018, 0.014)) * 0.35 + sin(dot(p, vec2(0.11, 0.09)) + time * 0.02) * 0.12);
    vec3 cBody = paletteBlend(tBody);
    vec3 cEdge = paletteBlend(mix(tEdge, tRidge, 0.5));
    vec3 cAlt = paletteBlend(tAlt);
    vec3 cWave = paletteBlend(tWave);
    float blendBH = 0.42 + 0.38 * sin(dot(p, vec2(0.06, 0.048)) + time * 0.035);
    vec3 mix1 = mix(cBody, cAlt, blendBH);
    vec3 mix2 = mix(mix1, cEdge, 0.28 + 0.15 * sin(time * 0.042 + dot(p, vec2(0.04, 0.05))));
    vec3 col = mix(mix2, cWave, 0.22);
    float grain = hash21(p * 420.0 + time * 0.03);
    col *= 0.97 + 0.03 * grain;
    return clamp(col, 0.0, 1.0);
  }

  void main() {
    vec2 uv = vUv;
    
    float screenAspect = uResolution.x / uResolution.y;
    float logoAspect = uLogoAspect;
    float rw = uResolution.x;
    float rh = uResolution.y;
    float coverT = max(rw / logoAspect, rh) * 0.5;
    vec2 finalLogoSize = vec2(coverT * logoAspect, coverT);
    float logoWidth = finalLogoSize.x / rw;
    float logoHeight = finalLogoSize.y / rh;
    float offsetX = (1.0 - logoWidth) * 0.5;
    float offsetY = (1.0 - logoHeight) * 0.5;
    vec2 logoUV = vec2(
      (uv.x - offsetX) / logoWidth,
      (uv.y - offsetY) / logoHeight
    );
    bool inTex = logoUV.x >= 0.0 && logoUV.x <= 1.0 && logoUV.y >= 0.0 && logoUV.y <= 1.0;
    float logoMask = inTex ? texture2D(uLogo, logoUV).r : 0.0;
    
    vec2 vel = texture2D(uVelocity, uv).xy;
    vec2 drift = vec2(
      sin(uTime * 0.035 + uv.y * 2.4) * 0.008,
      cos(uTime * 0.03 + uv.x * 2.2) * 0.007
    );
    vec2 warpUv = uv + vel * uVelWarp + drift;
    vec2 marbleCoord = warpUv * vec2(1.85 * screenAspect, 1.85);
    vec3 body = fluidPaintField(marbleCoord, uTime);
    vec3 swirlPaint = body;

    vec3 finalColor = mix(uBackgroundColor, swirlPaint, logoMask);
    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

const quadGeometry = createQuadGeometry();

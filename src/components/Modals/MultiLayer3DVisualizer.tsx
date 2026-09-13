import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

interface LayerData {
  id: string;
  accentColor: string;
}

interface Props {
  progress: number;
  layers: LayerData[];
}

export const MultiLayer3DVisualizer: React.FC<Props> = ({ progress, layers }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const meshesRef = useRef<THREE.Mesh[]>([]);
  const particlesRef = useRef<THREE.Points | null>(null);
  const reqIdRef = useRef<number>(0);

  useEffect(() => {
    if (!mountRef.current) return;

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0a0b10, 0.03);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 5, 12);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 5);
    scene.add(dirLight);

    // Create a particle system for data flow effect
    const particleGeometry = new THREE.BufferGeometry();
    const particleCount = 1000;
    const posArray = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount * 3; i++) {
      posArray[i] = (Math.random() - 0.5) * 20;
    }
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    const particleMaterial = new THREE.PointsMaterial({
      size: 0.05,
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending
    });
    const particleMesh = new THREE.Points(particleGeometry, particleMaterial);
    scene.add(particleMesh);
    particlesRef.current = particleMesh;

    // Create 3D planes for each layer
    meshesRef.current = layers.map((layer, index) => {
      const geometry = new THREE.BoxGeometry(8, 0.2, 4);
      const color = new THREE.Color(layer.accentColor);
      
      const material = new THREE.MeshPhysicalMaterial({
        color: color,
        metalness: 0.8,
        roughness: 0.2,
        transparent: true,
        opacity: 0.8,
        emissive: color,
        emissiveIntensity: 0.2,
      });

      const mesh = new THREE.Mesh(geometry, material);
      
      // Wireframe overlay for high-tech look
      const edges = new THREE.EdgesGeometry(geometry);
      const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 }));
      mesh.add(line);

      scene.add(mesh);
      return mesh;
    });

    const handleResize = () => {
      if (!mountRef.current || !cameraRef.current || !rendererRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };

    window.addEventListener('resize', handleResize);

    const animate = () => {
      reqIdRef.current = requestAnimationFrame(animate);
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(reqIdRef.current);
      if (rendererRef.current && mountRef.current) {
        mountRef.current.removeChild(rendererRef.current.domElement);
      }
    };
  }, [layers]);

  // Update positions based on progress
  useEffect(() => {
    if (!meshesRef.current.length || !particlesRef.current) return;

    const t = progress / 100; // 0.0 to 1.0

    // Rotate particles
    particlesRef.current.rotation.y += 0.005;
    particlesRef.current.rotation.x += 0.002;
    // As progress goes up, speed up particles
    const pointMat = particlesRef.current.material as THREE.PointsMaterial;
    pointMat.opacity = 0.2 + (t * 0.6);

    // Camera dynamic movement
    if (cameraRef.current) {
      cameraRef.current.position.x = Math.sin(t * Math.PI) * 5;
      cameraRef.current.position.y = 5 - (t * 2);
      cameraRef.current.position.z = 12 - (t * 4);
      cameraRef.current.lookAt(0, 0, 0);
    }

    const totalLayers = meshesRef.current.length;
    const spacing = 1.5;
    const startY = (totalLayers * spacing) / 2;

    meshesRef.current.forEach((mesh, index) => {
      // Initial position spread out vertically
      const initialY = startY - (index * spacing);
      
      // Target position is all merged at Y=0
      const targetY = 0;

      // Calculate current position interpolating based on progress
      mesh.position.y = THREE.MathUtils.lerp(initialY, targetY, t);

      // Add some floating animation if not fully merged
      if (t < 1) {
        const floatOffset = Math.sin(Date.now() * 0.002 + index) * 0.2 * (1 - t);
        mesh.position.y += floatOffset;
        
        // Rotation spread
        const rotSpread = (index - totalLayers/2) * 0.1 * (1 - t);
        mesh.rotation.x = rotSpread;
        mesh.rotation.z = Math.sin(Date.now() * 0.001 + index) * 0.05 * (1 - t);
      } else {
        mesh.rotation.set(0, 0, 0);
      }

      // Material effects
      const mat = mesh.material as THREE.MeshPhysicalMaterial;
      if (t > 0.9) {
        // Flash / Glow effect when merged
        mat.emissiveIntensity = 0.2 + Math.sin(Date.now() * 0.01) * 0.5;
        mat.opacity = 0.9;
      } else {
        mat.emissiveIntensity = 0.2;
        mat.opacity = 0.7 + (t * 0.3);
      }
    });

  }, [progress]);

  return (
    <div 
      ref={mountRef} 
      className="w-full h-48 bg-gradient-to-b from-[#0a0b10] to-[#121622] rounded-xs border border-[#1d2232] relative overflow-hidden"
    >
      <div className="absolute top-2 left-3 z-10 text-[10px] font-mono text-neutral-500 flex items-center space-x-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-[#0088ff] animate-pulse" />
        <span>3D RENDER ENGINE</span>
      </div>
    </div>
  );
};

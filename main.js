import * as THREE from './build/three.module.js';
import Stats from './build/stats.module.js';
import { GLTFLoader } from './build/GLTFLoader.js';
import { PMREMGenerator } from './build/PMREMGenerator.js';
import { DRACOLoader } from './build/DRACOLoader.js';
import { CarControls } from './build/CarControls.js';
import { PMREMCubeUVPacker } from './build/PMREMCubeUVPacker.js';

// ----------------------------------------------------
// Global state
// ----------------------------------------------------
let camera, scene, renderer, stats, carModel, materialsLib, envMap;
const bodyMatSelect = document.getElementById('body-mat');
const rimMatSelect = document.getElementById('rim-mat');
const glassMatSelect = document.getElementById('glass-mat');
const followCamera = document.getElementById('camera-toggle');
const lightingSelect = document.getElementById('lighting-select');

const clock = new THREE.Clock();
const carControls = new CarControls();
carControls.turningRadius = 75;

const carParts = {
  body: /** @type {THREE.Mesh[]} */([]),
  rims: /** @type {THREE.Mesh[]} */([]),
  glass: /** @type {THREE.Mesh[]} */([]),
};

const damping = 5.0;
const distance = 5;
const cameraTarget = new THREE.Vector3();

// Lighting presets container
let allLights = {};

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
function collectMeshesByNamePattern(root, regex) {
  const out = [];
  root.traverse((o) => {
    if (o.isMesh && regex.test((o.name || '').toLowerCase())) out.push(o);
  });
  return out;
}

function uniquePush(arr, item) {
  if (item && !arr.includes(item)) arr.push(item);
}

// Safe material color setter for single or multi-material meshes
function setMeshColor(mesh, color) {
  if (!mesh) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  mats.forEach((m) => {
    if (m && m.color && m.color.set) {
      m.color.set(color);
      m.needsUpdate = true;
    }
  });
}

function ensureCarReady() {
  if (!carModel || carParts.body.length === 0) {
    addMessage('Bot', 'Car model is still loading. Try again in a moment.');
    return false;
  }
  return true;
}

// ----------------------------------------------------
// Init
// ----------------------------------------------------
function init() {
  const container = document.getElementById('container');

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(3.25, 2.0, -5);
  camera.lookAt(0, 0.5, 0);

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xd7cbb1, 1, 80);

  const urls = ['px.jpg', 'nx.jpg', 'py.jpg', 'ny.jpg', 'pz.jpg', 'nz.jpg'];
  const loader = new THREE.CubeTextureLoader().setPath('textures/cube/skyboxsun25deg/');
  loader.load(urls, (texture) => {
    scene.background = texture;
    const pmremGenerator = new PMREMGenerator(texture);
    pmremGenerator.update(renderer);
    const pmremCubeUVPacker = new PMREMCubeUVPacker(pmremGenerator.cubeLods);
    pmremCubeUVPacker.update(renderer);
    envMap = pmremCubeUVPacker.CubeUVRenderTarget.texture;
    pmremGenerator.dispose();
    pmremCubeUVPacker.dispose();
  
        
    initCar();
    initMaterials();
    initMaterialSelectionMenus();
  });

  const ground = new THREE.Mesh(
    new THREE.PlaneBufferGeometry(2400, 2400),
    new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.15, depthWrite: false })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.renderOrder = 1;
  scene.add(ground);

  const grid = new THREE.GridHelper(400, 40, 0x000000, 0x000000);
  grid.material.opacity = 0.2;
  grid.material.depthWrite = false;
  grid.material.transparent = true;
  scene.add(grid);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.gammaOutput = true;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  stats = new Stats();
  container.appendChild(stats.dom);

  window.addEventListener('resize', onWindowResize, false);

  // init lights
  initLights();
  lightingSelect.addEventListener('change', updateLighting);

  renderer.setAnimationLoop(function () {
    update();
    renderer.render(scene, camera);
  });
}

function initCar() {
    DRACOLoader.setDecoderPath('js/libs/draco/gltf/');
    const loader = new GLTFLoader();
    loader.setDRACOLoader(new DRACOLoader());
    loader.load('models/ferrari.glb', function (gltf) {
        carModel = gltf.scene.children[0];
        carControls.setModel(carModel);

        carModel.traverse(function (child) {
            if (child.isMesh) {
                child.material.envMap = envMap;
            }
        });

        // shadow
        const texture = new THREE.TextureLoader().load('models/ferrari_ao.png');
        const shadow = new THREE.Mesh(
            new THREE.PlaneBufferGeometry(0.655 * 4, 1.3 * 4).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({ map: texture, opacity: 0.8, transparent: true })
        );
        shadow.renderOrder = 2;
        carModel.add(shadow);
        scene.add(carModel);

        // -------- Robust part collection
        // 1) explicit name
        const explicitBody = carModel.getObjectByName('body');
        if (explicitBody && explicitBody.isMesh) uniquePush(carParts.body, explicitBody);

        // 2) common naming patterns
        collectMeshesByNamePattern(carModel, /(\bbody\b|paint|carpaint|bodywork|car_body)/i)
            .forEach((m) => uniquePush(carParts.body, m));

        // 3) fallback: take non-glass, non-wheel, non-trim meshes
        if (carParts.body.length === 0) {
            carModel.traverse((o) => {
                if (!o.isMesh) return;
                const n = (o.name || '').toLowerCase();
                if (!/(glass|rim|tire|wheel|trim|logo|emblem|interior|seat|light|lamp)/.test(n)) {
                    uniquePush(carParts.body, o);
                }
            });
        }

        // Rims + trim
        ['rim_fl', 'rim_fr', 'rim_rr', 'rim_rl', 'trim'].forEach((n) => {
            const m = carModel.getObjectByName(n);
            if (m && m.isMesh) uniquePush(carParts.rims, m);
        });

        // Glass (collect by name pattern too)
        const glassNamed = collectMeshesByNamePattern(carModel, /(glass|windshield|window)/i);
        glassNamed.forEach((m) => uniquePush(carParts.glass, m));
        const glassOne = carModel.getObjectByName('glass');
        if (glassOne && glassOne.isMesh) uniquePush(carParts.glass, glassOne);

        // --- NEW: Add this section to find and store the doors ---
        carParts.doors = [];
        const leftDoor = carModel.getObjectByName('door_left'); // Use actual name
        const rightDoor = carModel.getObjectByName('door_right'); // Use actual name
        if (leftDoor) uniquePush(carParts.doors, leftDoor);
        if (rightDoor) uniquePush(carParts.doors, rightDoor);
        // --- END OF NEW SECTION ---

        updateMaterials();
    });
}

function initMaterials() {
  materialsLib = {
    main: [
      new THREE.MeshStandardMaterial({ color: 0xff4400, envMap: envMap, metalness: 0.9, roughness: 0.2, name: 'orange' }),
      new THREE.MeshStandardMaterial({ color: 0x001166, envMap: envMap, metalness: 0.9, roughness: 0.2, name: 'blue' }),
      new THREE.MeshStandardMaterial({ color: 0x990000, envMap: envMap, metalness: 0.9, roughness: 0.2, name: 'red' }),
      new THREE.MeshStandardMaterial({ color: 0x000000, envMap: envMap, metalness: 0.9, roughness: 0.5, name: 'black' }),
      new THREE.MeshStandardMaterial({ color: 0xffffff, envMap: envMap, metalness: 0.9, roughness: 0.5, name: 'white' }),
      new THREE.MeshStandardMaterial({ color: 0x555555, envMap: envMap, envMapIntensity: 2.0, metalness: 1.0, roughness: 0.2, name: 'metallic' }),
    ],
    glass: [
      new THREE.MeshStandardMaterial({ color: 0xffffff, envMap: envMap, metalness: 1, roughness: 0, opacity: 0.2, transparent: true, premultipliedAlpha: true, name: 'clear' }),
      new THREE.MeshStandardMaterial({ color: 0x000000, envMap: envMap, metalness: 1, roughness: 0, opacity: 0.2, transparent: true, premultipliedAlpha: true, name: 'smoked' }),
      new THREE.MeshStandardMaterial({ color: 0x001133, envMap: envMap, metalness: 1, roughness: 0, opacity: 0.2, transparent: true, premultipliedAlpha: true, name: 'blue' }),
      new THREE.MeshStandardMaterial({ color: 0x333333, envMap: envMap, metalness: 1, roughness: 0, opacity: 0.3, transparent: true, premultipliedAlpha: true, name: 'tinted' }),
    ],
  };
}

function initMaterialSelectionMenus() {
  function addOption(name, menu) {
    const option = document.createElement('option');
    option.text = name;
    option.value = name;
    menu.add(option);
  }
  materialsLib.main.forEach((material) => {
    addOption(material.name, bodyMatSelect);
    addOption(material.name, rimMatSelect);
  });
  materialsLib.glass.forEach((material) => addOption(material.name, glassMatSelect));

  bodyMatSelect.selectedIndex = 3;
  rimMatSelect.selectedIndex = 5;
  glassMatSelect.selectedIndex = 0;

  bodyMatSelect.addEventListener('change', updateMaterials);
  rimMatSelect.addEventListener('change', updateMaterials);
  glassMatSelect.addEventListener('change', updateMaterials);
}

function updateMaterials() {
  const bodyMat = materialsLib.main[bodyMatSelect.selectedIndex];
  const rimMat = materialsLib.main[rimMatSelect.selectedIndex];
  const glassMat = materialsLib.glass[glassMatSelect.selectedIndex];
  carParts.body.forEach((part) => (part.material = bodyMat));
  carParts.rims.forEach((part) => (part.material = rimMat));
  carParts.glass.forEach((part) => (part.material = glassMat));
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function update() {
  const delta = clock.getDelta();
  if (carModel) {
    carControls.update(delta / 3);
    if (carModel.position.length() > 200) {
      carModel.position.set(0, 0, 0);
      carControls.speed = 0;
    }
    if (followCamera.checked) {
      carModel.getWorldPosition(cameraTarget);
      cameraTarget.y = 2.5;
      cameraTarget.z += distance;
      camera.position.lerp(cameraTarget, delta * damping);
    } else {
      carModel.getWorldPosition(cameraTarget);
      cameraTarget.y += 0.5;
      camera.position.set(3.25, 2.0, -5);
    }
    camera.lookAt(carModel.position);
  }
  stats.update();
}

// ----------------------------------------------------
// Lighting System
// ----------------------------------------------------
function initLights() {
  // Directional Light (like sunlight)
  const directional = new THREE.DirectionalLight(0xffffff, 1.2);
  directional.position.set(5, 10, 7.5);
  directional.castShadow = true;

  // Ambient Light
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);

  // Night Light (blue tint, soft)
  const night = new THREE.HemisphereLight(0x223366, 0x000011, 0.6);

  // Dark Light (very dim)
  const dark = new THREE.PointLight(0x111133, 0.3, 50);
  dark.position.set(0, 5, 0);

  // Showroom Light
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8);
  hemi.position.set(0, 20, 0);
  const point1 = new THREE.PointLight(0xffffff, 1, 100);
  point1.position.set(10, 10, 10);
  const point2 = point1.clone();
  point2.position.set(-10, 10, -10);

  allLights = {
    directional: [directional],
    ambient: [ambient],
    night: [night],
    dark: [dark],
    showroom: [hemi, point1, point2],
  };

  // Add all but set invisible
  Object.values(allLights)
    .flat()
    .forEach((light) => {
      light.visible = false;
      scene.add(light);
    });
}

function updateLighting() {
  const mode = lightingSelect.value;
  Object.values(allLights)
    .flat()
    .forEach((light) => (light.visible = false));
  if (mode !== 'none' && allLights[mode]) {
    allLights[mode].forEach((light) => (light.visible = true));
  }
}

// ----------------------------------------------------
// Chatbot
// ----------------------------------------------------
const chatLog = document.getElementById('chat-log');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const voiceBtn = document.getElementById('voice-btn');

function addMessage(sender, text) {
  const msg = document.createElement('div');
  msg.textContent = text;
  msg.className = sender.toLowerCase();
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function handleCommand(raw) {
   

    const text = (raw || '').toLowerCase();

    // Check for "open doors" command
    if (text.includes('open') && text.includes('door')) {
        openDoors();
        addMessage('Bot', 'Opening doors.');
        return;
    }

    
    // Check for Body Color commands
    if (text.includes('body') || text.includes('paint')) {
        for (const mat of materialsLib.main) {
            if (text.includes(mat.name.toLowerCase())) {
                bodyMatSelect.value = mat.name;
                updateMaterials();
                addMessage('Bot', `Body color set to ${mat.name}.`);
                return;
            }
        }
    }

    // Check for Rim/details color commands
    if (text.includes('rim') || text.includes('details')) {
        for (const mat of materialsLib.main) {
            if (text.includes(mat.name.toLowerCase())) {
                rimMatSelect.value = mat.name;
                updateMaterials();
                addMessage('Bot', `Rim color set to ${mat.name}.`);
                return;
            }
        }
    }

    // Check for Glass color commands
    if (text.includes('glass')) {
        for (const mat of materialsLib.glass) {
            if (text.includes(mat.name.toLowerCase())) {
                glassMatSelect.value = mat.name;
                updateMaterials();
                addMessage('Bot', `Glass color set to ${mat.name}.`);
                return;
            }
        }
    }

    // Check for Lighting commands
    if (text.includes('light') || text.includes('lighting')) {
        const lightingOptions = Object.keys(allLights);
        for (const option of lightingOptions) {
            if (text.includes(option.toLowerCase())) {
                lightingSelect.value = option;
                updateLighting();
                addMessage('Bot', `Lighting set to ${option}.`);
                return;
            }
        }
    }

    // Fallback: If no command is recognized, provide a helpful response.
    addMessage('Bot', 'I didn’t understand that. Try a command like "make body red" or "ambient light".');
}

sendBtn.onclick = () => {
  if (chatInput.value.trim()) {
    addMessage('You', chatInput.value);
    handleCommand(chatInput.value);
    chatInput.value = '';
  }
};
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    sendBtn.click();
  }
});

// Voice Recognition setup
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition && window.isSecureContext) {
  const recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  voiceBtn.addEventListener('click', () => {
    addMessage('Bot', 'Listening...');
    try {
      recognition.start();
    } catch (_) {}
  });

  recognition.onresult = (event) => {
    const voiceText = event.results[0][0].transcript;
    addMessage('You', voiceText);
    handleCommand(voiceText);
  };
  recognition.onerror = (e) => {
    addMessage('Bot', 'Mic error: ' + (e.error || 'unknown'));
  };
} else {
  voiceBtn.disabled = true;
  voiceBtn.title = 'Voice requires a supported browser and HTTPS.';
}

// Initial bot message on load
addMessage('Bot', '👋 Hi! Try "make body red" or "ambient light".');
init();
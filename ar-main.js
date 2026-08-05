document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('enter-ar');
  const scene = document.querySelector('a-scene');
  const car = document.getElementById('car');

  button.addEventListener('click', () => {
    button.style.display = 'none';
    scene.style.display = 'block';
  });

  // Rotate car slowly
  function rotateCar() {
    if (car && car.getAttribute('rotation')) {
      let rotation = car.getAttribute('rotation');
      car.setAttribute('rotation', {
        x: rotation.x,
        y: rotation.y + 0.5,
        z: rotation.z
      });
    }
    requestAnimationFrame(rotateCar);
  }
  rotateCar();

  // Tap to randomize color
  car.addEventListener('click', () => {
    const mesh = car.getObject3D('mesh');
    if (mesh) {
      mesh.traverse(child => {
        if (child.isMesh) {
          child.material.color.set(Math.random() * 0xffffff);
        }
      });
    }
  });
});
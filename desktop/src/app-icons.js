"use strict";
const fs = require("fs");
const path = require("path");

function iconPath(resourcesPath = process.resourcesPath) {
  return [
    path.join(__dirname, "..", "build", "icon.png"),
    resourcesPath && path.join(resourcesPath, "icon.png"),
  ].filter(Boolean).find(file => fs.existsSync(file)) || null;
}

function createTrayIcon(nativeImage, resourcesPath = process.resourcesPath) {
  const directories = [
    path.join(__dirname, "..", "build", "aura-icons"),
    resourcesPath && path.join(resourcesPath, "aura-icons"),
  ].filter(Boolean);
  const directory = directories.find(dir => fs.existsSync(path.join(dir, "16.png")));
  if (directory) {
    const image = nativeImage.createEmpty();
    // Keep a 16-DIP image with actual pixels for common Windows DPI scales.
    for (const size of [16, 20, 24, 32]) {
      const file = path.join(directory, `${size}.png`);
      if (fs.existsSync(file)) image.addRepresentation({
        scaleFactor: size / 16,
        dataURL: "data:image/png;base64," + fs.readFileSync(file).toString("base64"),
      });
    }
    if (!image.isEmpty()) return image;
  }
  const fallback = iconPath(resourcesPath);
  return fallback ? nativeImage.createFromPath(fallback).resize({ width: 16, height: 16 }) : null;
}

module.exports = { iconPath, createTrayIcon };

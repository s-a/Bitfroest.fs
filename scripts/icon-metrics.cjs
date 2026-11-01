function fitIcon(bounds, unitsPerEm) {
  const { xMin, yMin, xMax, yMax } = bounds;
  if (![xMin, yMin, xMax, yMax, unitsPerEm].every(Number.isFinite) || xMax <= xMin || yMax <= yMin || unitsPerEm <= 0) {
    throw new Error('Invalid icon bounds or units per em.');
  }
  const extent = Math.max(xMax - xMin, yMax - yMin);
  const fontScale = Math.min(1, unitsPerEm / extent);
  return {
    fontScale,
    left: 0.5 - (xMin + xMax) * fontScale / (2 * unitsPerEm),
    top: 0.5 - fontScale + (yMin + yMax) * fontScale / (2 * unitsPerEm)
  };
}

module.exports = { fitIcon };

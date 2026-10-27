// Small bitmap digits avoid font loading and work offline at taskbar icon size.
const DIGITS = ['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
function badge(count, nativeImage) {
  const size = 16, pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if ((x-7.5)**2+(y-7.5)**2 < 63) {
    const i=(y*size+x)*4; pixels[i]=77; pixels[i+1]=168; pixels[i+2]=93; pixels[i+3]=255;
  }
  const label=count>99?'99+':String(count), left=Math.floor((size-(label.length*4-1))/2);
  for (let n=0;n<label.length;n++) {
    const glyph=label[n]==='+'?'000010111010000':DIGITS[Number(label[n])];
    for (let p=0;p<15;p++) if (glyph[p]==='1') { const i=((5+Math.floor(p/3))*size+left+n*4+p%3)*4; pixels[i]=pixels[i+1]=pixels[i+2]=255; pixels[i+3]=255; }
  }
  return nativeImage.createFromBitmap(pixels,{width:size,height:size});
}
module.exports={badge};

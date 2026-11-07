// Reproduce apps/web/public/icon.svg as a multiresolution Windows executable icon.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

internal static class SetupIcon {
    private static Bitmap Artwork() {
        Bitmap bitmap = new Bitmap(512, 512, PixelFormat.Format32bppArgb);
        using (Graphics graphics = Graphics.FromImage(bitmap)) {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            graphics.Clear(Color.Transparent);
            using (GraphicsPath background = new GraphicsPath()) {
                background.AddArc(0, 0, 144, 144, 180, 90);
                background.AddArc(368, 0, 144, 144, 270, 90);
                background.AddArc(368, 368, 144, 144, 0, 90);
                background.AddArc(0, 368, 144, 144, 90, 90);
                background.CloseFigure();
                graphics.FillPath(Brushes.Black, background);
            }
            using (FontFamily family = new FontFamily("Arial"))
            using (GraphicsPath red = new GraphicsPath())
            using (GraphicsPath white = new GraphicsPath())
            using (SolidBrush brandRed = new SolidBrush(Color.FromArgb(229, 9, 20))) {
                red.AddString("S", family, (int)FontStyle.Bold, 248f, new PointF(58, 102), StringFormat.GenericTypographic);
                white.AddString("AI", family, (int)FontStyle.Bold, 248f, new PointF(204, 102), StringFormat.GenericTypographic);
                graphics.FillPath(brandRed, red);
                graphics.FillPath(Brushes.White, white);
            }
        }
        return bitmap;
    }

    private static byte[] IconImage(Bitmap source, int size) {
        using (Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb)) {
            using (Graphics graphics = Graphics.FromImage(bitmap)) {
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.DrawImage(source, new Rectangle(0, 0, size, size));
            }
            using (MemoryStream stream = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(stream)) {
                int maskStride = ((size + 31) / 32) * 4;
                writer.Write(40); writer.Write(size); writer.Write(size * 2);
                writer.Write((short)1); writer.Write((short)32); writer.Write(0);
                writer.Write(size * size * 4); writer.Write(0); writer.Write(0); writer.Write(0); writer.Write(0);
                for (int y = size - 1; y >= 0; y--)
                    for (int x = 0; x < size; x++) {
                        Color color = bitmap.GetPixel(x, y);
                        writer.Write(color.B); writer.Write(color.G); writer.Write(color.R); writer.Write(color.A);
                    }
                writer.Write(new byte[maskStride * size]);
                return stream.ToArray();
            }
        }
    }

    private static int Main(string[] args) {
        if (args.Length != 1) return 2;
        int[] sizes = { 16, 24, 32, 48, 64, 256 };
        List<byte[]> images = new List<byte[]>();
        using (Bitmap source = Artwork()) foreach (int size in sizes) images.Add(IconImage(source, size));
        using (FileStream file = new FileStream(args[0], FileMode.CreateNew, FileAccess.Write))
        using (BinaryWriter writer = new BinaryWriter(file)) {
            writer.Write((short)0); writer.Write((short)1); writer.Write((short)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++) {
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)0); writer.Write((byte)0);
                writer.Write((short)1); writer.Write((short)32);
                writer.Write(images[i].Length); writer.Write(offset);
                offset += images[i].Length;
            }
            foreach (byte[] image in images) writer.Write(image);
        }
        return 0;
    }
}

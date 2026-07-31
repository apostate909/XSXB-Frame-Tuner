param(
  [Parameter(Mandatory = $true)]
  [string]$BodySource,
  [Parameter(Mandatory = $true)]
  [string]$BreakupSource,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [int]$Size = 256
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$resolvedBody = (Resolve-Path -LiteralPath $BodySource).Path
$resolvedBreakup = (Resolve-Path -LiteralPath $BreakupSource).Path
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

if (-not ("XsxbCoherentTrailTextures" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class XsxbCoherentTrailTextures
{
    private static double Clamp01(double value)
    {
        return Math.Max(0.0, Math.Min(1.0, value));
    }

    private static double SmoothStep(double edge0, double edge1, double value)
    {
        if (edge1 <= edge0) return value >= edge1 ? 1.0 : 0.0;
        double phase = Clamp01((value - edge0) / (edge1 - edge0));
        return phase * phase * (3.0 - 2.0 * phase);
    }

    private static byte[] ReadLuma(string path, int size)
    {
        using (var source = new Bitmap(path))
        using (var resized = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        {
            using (var graphics = Graphics.FromImage(resized))
            {
                graphics.Clear(Color.Black);
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.DrawImage(source, new Rectangle(0, 0, size, size));
            }
            var rect = new Rectangle(0, 0, size, size);
            var data = resized.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var pixels = new byte[Math.Abs(data.Stride) * size];
                Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
                var luma = new byte[size * size];
                for (int y = 0; y < size; y++)
                {
                    int row = y * data.Stride;
                    for (int x = 0; x < size; x++)
                    {
                        int sourceIndex = row + x * 4;
                        double value = pixels[sourceIndex + 2] * 0.2126
                            + pixels[sourceIndex + 1] * 0.7152
                            + pixels[sourceIndex] * 0.0722;
                        luma[y * size + x] = (byte)Math.Max(0, Math.Min(255, Math.Round(value)));
                    }
                }
                return luma;
            }
            finally
            {
                resized.UnlockBits(data);
            }
        }
    }

    private static void WriteLuma(string path, byte[] luma, int size)
    {
        using (var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        {
            var rect = new Rectangle(0, 0, size, size);
            var data = bitmap.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try
            {
                var pixels = new byte[Math.Abs(data.Stride) * size];
                for (int y = 0; y < size; y++)
                {
                    int row = y * data.Stride;
                    for (int x = 0; x < size; x++)
                    {
                        int sourceIndex = y * size + x;
                        int targetIndex = row + x * 4;
                        byte value = luma[sourceIndex];
                        pixels[targetIndex] = value;
                        pixels[targetIndex + 1] = value;
                        pixels[targetIndex + 2] = value;
                        pixels[targetIndex + 3] = 255;
                    }
                }
                Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
            bitmap.Save(path, ImageFormat.Png);
        }
    }

    public static void Generate(string bodySource, string breakupSource, string outputDirectory, int size)
    {
        byte[] bodySourceLuma = ReadLuma(bodySource, size);
        byte[] breakupSourceLuma = ReadLuma(breakupSource, size);
        byte[] outerGlow = new byte[size * size];
        byte[] body = new byte[size * size];
        byte[] breakup = new byte[size * size];

        double cut = size * 0.18;
        double edgeSoftness = Math.Max(8.0, size * 0.014);
        double headSpread = Math.Max(36.0, size * 0.065);
        double rimWidth = Math.Max(8.0, size * 0.012);

        for (int y = 0; y < size; y++)
        {
            for (int x = 0; x < size; x++)
            {
                int index = y * size + x;
                double topBoundary = x < cut ? cut - x : 0.0;
                double insideDistance = y - topBoundary;
                double inside = SmoothStep(0.0, edgeSoftness, insideDistance);
                double bottom = 1.0 - SmoothStep(size * 0.965, size - 1.0, y);
                double tail = 1.0 - SmoothStep(size * 0.76, size - 1.0, x);
                double envelope = inside * bottom * tail;

                double cutDistance = x + y - cut;
                double headGate = 1.0 - SmoothStep(size * 0.22, size * 0.48, x);
                double head = Math.Exp(-(cutDistance * cutDistance) / (2.0 * headSpread * headSpread))
                    * headGate
                    * SmoothStep(0.0, edgeSoftness * 0.65, cutDistance);

                double sourceBody = Math.Pow(bodySourceLuma[index] / 255.0, 0.84);
                double bodyValue = Math.Max(sourceBody * envelope, head * 0.96 * envelope);

                double sourceBreakup = breakupSourceLuma[index] / 255.0;
                double breakupBands = SmoothStep(0.075, 0.78, sourceBreakup);
                double breakupValue = Math.Max(breakupBands * envelope, head * 0.94 * envelope);

                double rimDistance = Math.Max(0.0, insideDistance);
                double hardRim = Math.Exp(-Math.Pow((rimDistance - rimWidth * 0.45) / rimWidth, 2.0));
                double softRim = Math.Exp(-rimDistance / Math.Max(1.0, size * 0.035)) * 0.30;
                double outerValue = Math.Max(hardRim, softRim) * inside * tail * bottom;
                outerValue = Math.Max(outerValue, head * 0.82 * envelope);

                body[index] = (byte)Math.Round(Clamp01(bodyValue) * 255.0);
                breakup[index] = (byte)Math.Round(Clamp01(breakupValue) * 255.0);
                outerGlow[index] = (byte)Math.Round(Clamp01(outerValue) * 255.0);
            }
        }

        WriteLuma(Path.Combine(outputDirectory, "coherent_outer_glow_luma.png"), outerGlow, size);
        WriteLuma(Path.Combine(outputDirectory, "coherent_trail_body_luma.png"), body, size);
        WriteLuma(Path.Combine(outputDirectory, "coherent_breakup_luma.png"), breakup, size);
    }
}
'@ -ReferencedAssemblies System.Drawing
}

[XsxbCoherentTrailTextures]::Generate($resolvedBody, $resolvedBreakup, $resolvedOutput, $Size)
Get-Item -LiteralPath (
  [System.IO.Path]::Combine($resolvedOutput, "coherent_outer_glow_luma.png")
), (
  [System.IO.Path]::Combine($resolvedOutput, "coherent_trail_body_luma.png")
), (
  [System.IO.Path]::Combine($resolvedOutput, "coherent_breakup_luma.png")
) | Select-Object FullName, Length, LastWriteTime

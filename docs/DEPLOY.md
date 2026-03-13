# Deploying to GitHub Pages

## Quick Deploy

1. Push to GitHub:
   ```bash
   git add docs/
   git commit -m "Add landing page and pitch deck"
   git push origin main
   ```

2. Enable GitHub Pages:
   - Go to repo **Settings** → **Pages**
   - Source: **Deploy from a branch**
   - Branch: `main` → `/docs`
   - Click **Save**

3. Your site will be live at:
   ```
   https://YOUR-USERNAME.github.io/codebase-brain/
   ```

## Files

| File | Purpose |
|------|---------|
| `index.html` | Landing page (single-file, no dependencies) |
| `pitch-deck.md` | Pitch deck in Markdown (convert to slides) |
| `CNAME` | Custom domain (leave empty for github.io) |

## Custom Domain (Optional)

1. Add your domain to `CNAME`:
   ```
   codebase-brain.dev
   ```

2. Configure DNS:
   - Add CNAME record: `www` → `YOUR-USERNAME.github.io`
   - Add A records for apex domain pointing to GitHub's IPs

## Converting Pitch Deck to Slides

**Option 1: Marp (Recommended)**
```bash
npm install -g @marp-team/marp-cli
marp pitch-deck.md -o pitch-deck.pdf
marp pitch-deck.md -o pitch-deck.pptx
```

**Option 2: reveal.js**
```bash
npx reveal-md pitch-deck.md
```

**Option 3: Google Slides**
- Copy/paste content into Google Slides
- Use a minimal template

## Updating the Landing Page

The `index.html` is a single self-contained file with inline CSS. To customize:

1. **Colors:** Edit CSS variables at the top (`:root { ... }`)
2. **Content:** Edit the HTML sections directly
3. **GitHub link:** Replace `your-username` with your actual GitHub username

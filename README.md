# PROMPT MRI
**not an optimizer. a diagnostic.**

---

**Product Name:** Prompt MRI  
**Team Name:** Out-of Tokens  
**Members:** Soham Joshi  

*The Project was created as part of the Hack AI Hackathon 2026*

---

Prompt MRI is a forensic diagnostic engine for the human-AI interaction loop. It deconstructs the "black box" of LLM behavior by scanning your prompts for structural flaws—ambiguities, hidden assumptions, and missing context—before they lead to failure. For AI-generated output, it applies a second forensic layer to detect the structural signals of hallucination, such as unsupported specificity and overconfident phrasing. It doesn't just optimize; it provides a forensic scan of why your AI interaction is succeeding or failing.

---

## ⚡️ PHASES

### Phase 1: Prompt MRI (The Scan)
- **Diagnostic Engine:** Analyzes user prompts for primary goals, task archetypes, and model execution plans.
- **Findings Grid:** Identifies explicit/implicit constraints, assumptions, and missing information.
- **Ambiguity Detection:** Highlights high-confidence zones where the model might guess your intent.
- **Optimization Loop:** Offers "Clarification vs. Optimization" paths to finalize a high-precision prompt.

### Phase 2: Hallucination Risk Analyzer (The Detector)
- **Structural Forensics:** Detects patterns statistically associated with "confabulation" or "hallucination."
- **Signal Logic:** Scans for unsupported specificity, overly precise fabricated details, and fake-looking citation patterns.
- **Risk Scoring:** Provides a score from 0-100 indicating the probability that the text contains invented information.

---

## 🛠️ TECH STACK
- **Core:** Vanilla HTML5, CSS3 (Bespoke Hackathon Brutalism aesthetic), and Pure JavaScript (ES6+).
- **Brain:** Powered by the **Gemini 1.5 Flash 3 Preview** model via Google Generative AI API.
- **Zero Dependencies:** No frameworks. No build steps. No external libraries.

---

## 🚀 GETTING STARTED

### 1. Configure API Keys
The app looks for a global object `window.__PROMPT_MRI_KEYS__` defined in `keys.js`. To keep your key safe:
1. Copy `keys.example.js` to a new file named `keys.js`.
2. Add your Gemini API key inside `keys.js`:
   ```javascript
   window.__PROMPT_MRI_KEYS__ = {
     gemini: 'YOUR_GEMINI_API_KEY_HERE',
   };
   ```
3. **Note:** `keys.js` is automatically ignored by `.gitignore`, so it will never be committed to your repository when you push to GitHub.

### 2. Run Locally
Because the app uses `fetch` for API calls, it should be run from a local server to avoid CORS issues.

**Via Python:**
```bash
python3 -m http.server 8000
```
Then visit `http://localhost:8000`

**Via Node.js:**
```bash
npx serve .
```

---

## 🎨 DESIGN AESTHETIC
Built with a **"Hackathon Brutalism"** design system:
- High-contrast fluorescent lime on black.
- Oversized "Bebas Neue" typography.
- Tape-style labels and sticker motifs.
- Grainy newsprint overlays for a raw, "built at 3 AM" feel.

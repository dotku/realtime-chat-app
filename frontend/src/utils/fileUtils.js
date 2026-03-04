import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export async function extractPdfText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
  }
  return pages.join('\n\n').trim();
}

export async function handleFileSelect(e, setPendingAttachment) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('File too large. Maximum 5MB.'); e.target.value = ''; return; }

  const isDocx = file.name.toLowerCase().endsWith('.docx') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

  if (isDocx) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const extractedText = result.value?.trim() || '';
      setPendingAttachment({ name: file.name, type: file.type, extractedText, data: null });
    } catch (err) {
      console.error('DOCX extraction failed:', err);
      alert('Could not read the Word document. Please copy-paste the content instead.');
      e.target.value = '';
    }
    return;
  }

  if (isPdf) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const extractedText = await extractPdfText(arrayBuffer);
      if (!extractedText) {
        setPendingAttachment({
          name: file.name, type: file.type,
          extractedText: '[Scanned PDF — no selectable text could be extracted. Please copy-paste the content manually.]',
          data: null,
        });
      } else {
        setPendingAttachment({ name: file.name, type: file.type, extractedText, data: null });
      }
    } catch (err) {
      console.error('PDF extraction failed:', err);
      alert('Could not read the PDF. Please copy-paste the content instead.');
      e.target.value = '';
    }
    return;
  }

  // All other files: read as data URL
  const reader = new FileReader();
  reader.onload = ev => setPendingAttachment({ name: file.name, type: file.type, data: ev.target.result });
  reader.readAsDataURL(file);
}

---
section: Fixed
---

- **Document worker:** The deployment kit's document worker image now includes OCRmyPDF, Tesseract and German and English language data for local Knowledge Base OCR. Rebuild the worker image when updating with capabilities KB-9; the native OCR dependencies increase its image size. Rollback leaves retained extraction results unchanged.

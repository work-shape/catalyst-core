---
section: Changed
---

- **Instance > Users:** every full name keeps its room. Last active, then Access, then Status fold into the details under the name when the list runs out of room, so at phone width the name reads whole and the folded values stay in the row. Sign-in methods left the list; the person's detail lists them under "Sign-in methods". An active account nobody has signed in to yet reads "Invited", in the list, its filter, the count under the title and the detail. The selection boxes are the library's checkbox.
- **UI library:** a `TableHead` takes a `priority`. Once the table cannot show every column at its full width, the column with the highest number folds first into the cell marked `rowDetail`, under the head's label. The table measures its box and refits as it narrows or widens. A table without priorities is unchanged.

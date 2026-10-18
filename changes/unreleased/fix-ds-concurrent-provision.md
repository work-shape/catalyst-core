---
section: Fixed
---

- Data Stores published at once no longer fail to provision with SQLSTATE XX000 ("tuple concurrently updated"). Every store takes CONNECT on the platform database from PUBLIC, and two of those grants at the same moment collided on the one catalog row of that database; they now take turns under an advisory lock. The rest of provisioning still runs side by side, so how many stores are provisioned at once is unchanged.
- Knowledge Bases published at once on one Data Store no longer fail with HTTP 500 and the same error. The grants to their reader roles write onto the same catalog rows of the store's database, its schema `public` and its tables; they now take turns under an advisory lock of that store's database. Grants on different stores do not wait for each other.

#ifndef HASH_H
#define HASH_H

#define FNV_OFFSET_BASIS 1469598103934665603ULL
#define FNV_PRIME        1099511628211ULL

typedef unsigned long kv_hash_t;

kv_hash_t fnv1a(const char *data, unsigned long len);

#endif

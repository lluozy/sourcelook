#include "hash.h"

kv_hash_t fnv1a(const char *data, unsigned long len)
{
    kv_hash_t h = FNV_OFFSET_BASIS;
    unsigned long i;

    for (i = 0; i < len; i++) {
        h ^= (unsigned char)data[i];
        h *= FNV_PRIME;
    }

    return h;
}

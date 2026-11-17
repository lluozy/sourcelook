#ifndef KVSTORE_H
#define KVSTORE_H

#include <stddef.h>

#define KV_MAX_KEY   64
#define KV_MAX_VAL   256
#define KV_BUCKETS   1024

#define KV_OK        0
#define KV_ENOENT   -1
#define KV_EFULL    -2

struct kv_entry {
    char key[KV_MAX_KEY];
    char val[KV_MAX_VAL];
    struct kv_entry *next;
    unsigned long hits;
};

struct kv_store {
    struct kv_entry *buckets[KV_BUCKETS];
    size_t count;
    size_t max_entries;
};

typedef int (*kv_visit_fn)(const char *key, const char *val, void *arg);

int   kv_init(struct kv_store *s, size_t max_entries);
void  kv_free(struct kv_store *s);
int   kv_put(struct kv_store *s, const char *key, const char *val);
const char *kv_get(struct kv_store *s, const char *key);
int   kv_del(struct kv_store *s, const char *key);
void  kv_foreach(struct kv_store *s, kv_visit_fn fn, void *arg);
size_t kv_count(struct kv_store *s);

#endif

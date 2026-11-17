#include <stdlib.h>
#include <string.h>

#include "kvstore.h"
#include "hash.h"

static size_t kv_strnlen(const char *s, size_t max)
{
    size_t n = 0;

    while (n < max && s[n] != '\0')
        n++;

    return n;
}

static struct kv_entry *kv_find(struct kv_store *s, const char *key)
{
    kv_hash_t h = fnv1a(key, kv_strnlen(key, KV_MAX_KEY));
    struct kv_entry *e = s->buckets[h % KV_BUCKETS];

    while (e != NULL) {
        if (strcmp(e->key, key) == 0)
            return e;
        e = e->next;
    }

    return NULL;
}

int kv_init(struct kv_store *s, size_t max_entries)
{
    if (s == NULL)
        return -1;

    memset(s, 0, sizeof(*s));
    s->max_entries = max_entries;

    return KV_OK;
}

void kv_free(struct kv_store *s)
{
    size_t i;

    if (s == NULL)
        return;

    for (i = 0; i < KV_BUCKETS; i++) {
        struct kv_entry *e = s->buckets[i];

        while (e != NULL) {
            struct kv_entry *next = e->next;
            free(e);
            e = next;
        }
        s->buckets[i] = NULL;
    }

    s->count = 0;
}

int kv_put(struct kv_store *s, const char *key, const char *val)
{
    struct kv_entry *e;
    kv_hash_t h;

    if (s == NULL || key == NULL || val == NULL)
        return -1;

    if (kv_strnlen(key, KV_MAX_KEY) >= KV_MAX_KEY)
        return -1;

    e = kv_find(s, key);
    if (e == NULL) {
        if (s->max_entries > 0 && s->count >= s->max_entries)
            return KV_EFULL;

        h = fnv1a(key, kv_strnlen(key, KV_MAX_KEY));
        e = (struct kv_entry *)calloc(1, sizeof(*e));
        if (e == NULL)
            return -1;

        strncpy(e->key, key, KV_MAX_KEY - 1);
        e->next = s->buckets[h % KV_BUCKETS];
        s->buckets[h % KV_BUCKETS] = e;
        s->count++;
    }

    strncpy(e->val, val, KV_MAX_VAL - 1);
    e->val[KV_MAX_VAL - 1] = '\0';

    return KV_OK;
}

const char *kv_get(struct kv_store *s, const char *key)
{
    struct kv_entry *e;

    if (s == NULL || key == NULL)
        return NULL;

    e = kv_find(s, key);
    if (e == NULL)
        return NULL;

    e->hits++;

    return e->val;
}

int kv_del(struct kv_store *s, const char *key)
{
    kv_hash_t h;
    struct kv_entry **pp;

    if (s == NULL || key == NULL)
        return -1;

    h = fnv1a(key, kv_strnlen(key, KV_MAX_KEY));
    pp = &s->buckets[h % KV_BUCKETS];

    while (*pp != NULL) {
        if (strcmp((*pp)->key, key) == 0) {
            struct kv_entry *victim = *pp;
            *pp = victim->next;
            free(victim);
            s->count--;
            return KV_OK;
        }
        pp = &(*pp)->next;
    }

    return KV_ENOENT;
}

void kv_foreach(struct kv_store *s, kv_visit_fn fn, void *arg)
{
    size_t i;

    if (s == NULL || fn == NULL)
        return;

    for (i = 0; i < KV_BUCKETS; i++) {
        struct kv_entry *e = s->buckets[i];

        while (e != NULL) {
            if (fn(e->key, e->val, arg) != 0)
                return;
            e = e->next;
        }
    }
}

size_t kv_count(struct kv_store *s)
{
    return s == NULL ? 0 : s->count;
}

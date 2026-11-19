#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dlfcn.h>
#include <unistd.h>
#include "../../drm/embedded_loader.h"

typedef int (*fn_path)(const char *);
typedef int (*fn_buf)(const uint8_t *, int);
typedef int (*fn_check)(int64_t);

static int shim_atfork(void(*a)(void),void(*b)(void),void(*c)(void),void*d){(void)a;(void)b;(void)c;(void)d;return 0;}
static void *shim_memchr_chk(const void *s,int c,size_t n,size_t bs){(void)bs;return(void*)memchr(s,c,n);}
static void *hook(const char *sym,const char *req){
    (void)req;
    if(!sym) return NULL;
    if(!strcmp(sym,"__register_atfork")) return (void*)shim_atfork;
    if(!strcmp(sym,"__memchr_chk"))      return (void*)shim_memchr_chk;
    return NULL;
}
static int hex_val(char c){
    if(c>='0'&&c<='9') return c-'0';
    if(c>='a'&&c<='f') return c-'a'+10;
    if(c>='A'&&c<='F') return c-'A'+10;
    return 0;
}

int main(int argc, char **argv)
{
    const char *dir = argc>1?argv[1]:"/tmp/stage5-oldstack-test";
    setenv("HYBRIS_LINKER_DIR","../../drm/hybris-linker",1);
    setenv("HYBRIS_LD_LIBRARY_PATH","../../drm/rootfs/system/lib64",1);
    setenv("HYBRIS_ANDROID_LIB64","../../drm/rootfs/system/lib64",1);
    setenv("ANDROID_ROOT","/tmp/tadi-root",0); setenv("ANDROID_DATA","/tmp/tadi-data",0);

    if(embedded_loader_init()!=0){fprintf(stderr,"init: %s\n",embedded_dlerror());return 1;}
    embedded_set_hook_callback(hook);

    const char *libs[]={"libCoreFP.so","libCoreADI.so","libstoreservicescore.so",NULL};
    for(int i=0;libs[i];i++){
        if(!embedded_dlopen(libs[i],RTLD_NOW|RTLD_GLOBAL)){
            fprintf(stderr,"%s: %s\n",libs[i],embedded_dlerror());return 1;
        }
        printf("loaded %s\n",libs[i]);
    }

    fn_path setpath=NULL,load=NULL;
    fn_buf  setid=NULL;
    fn_check isprov=NULL;
    *(void**)&setpath=embedded_dlsym("nf92ngaK92");
    *(void**)&load   =embedded_dlsym("kq56gsgHG6");
    *(void**)&setid  =embedded_dlsym("Sph98paBcz");
    *(void**)&isprov =embedded_dlsym("aslgmuibau");
    if(!setpath||!load||!setid||!isprov){fputs("missing syms\n",stderr);return 1;}

    char hex_id[20]={};
    char did_path[512]; snprintf(did_path,sizeof did_path,"%s/device-id",dir);
    FILE *f=fopen(did_path,"rb");
    if(f){fread(hex_id,1,16,f);fclose(f);}
    printf("hex_id: %.16s\n",hex_id);

    uint8_t bin_id[8];
    for(int i=0;i<8;i++) bin_id[i]=(hex_val(hex_id[2*i])<<4)|hex_val(hex_id[2*i+1]);
    printf("bin_id:"); for(int i=0;i<8;i++) printf(" %02x",bin_id[i]); printf("\n");

    int rc;
    int64_t dsids[]={0LL,21997672533LL};
    const char *dsid_names[]={"0","21997672533"};
    uint8_t *ids[]={NULL,(uint8_t*)hex_id,bin_id};
    int lens[]={0,16,8};
    const char *idnames[]={"none    ","hex-16  ","bin-8   "};

    for(int d=0;d<2;d++){
        for(int i=0;i<3;i++){
            setpath(dir); load(dir); setpath(dir);
            if(ids[i]) setid(ids[i],lens[i]);
            rc=isprov(dsids[d]);
            printf("dsid=%-15s id=%s -> %d%s\n",dsid_names[d],idnames[i],rc,
                   rc==0?" *** PROVISIONED ***":"");
        }
    }
    return 0;
}

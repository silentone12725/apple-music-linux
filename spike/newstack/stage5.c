/*
 * Stage 5: Bootstrap provision the 6.5.2 libCoreADI using the existing
 * provisioned libstoreservicescore identity.
 *
 * Strategy (breaks the circular dependency):
 *   PHASE A — child process, OLD rootfs/system/lib64:
 *     Load libstoreservicescore with the existing adi.pb + device-id.
 *     Call ADIOTPRequest → real X-Apple-I-MD / X-Apple-I-MD-M headers.
 *     Write base64 otp + mid to a tmp file and exit.
 *
 *   PHASE B — parent process, rootfs-6.5.2/system/lib64:
 *     Read the headers written by phase A.
 *     Use them to fetch the GrandSlam bag.
 *     POST to bag["midStartProvisioning"] → SPIM.
 *     Call new stack ADIProvisioningStart(spim) → CPIM.
 *     POST CPIM to bag["midFinishProvisioning"] → PTM, TK.
 *     Call ADIProvisioningEnd(session, ptm, tk).
 *     Verify ADIIsMachineProvisioned == 0.
 *
 * Usage:
 *   ./stage5 <drm-files-dir> <new-adi-dir> [dsid]
 *   # drm-files-dir: directory with existing adi.pb + device-id
 *   # new-adi-dir:   empty dir where 6.5.2 adi.pb will be written
 *   # dsid:          account DSID (default 21997672533)
 *
 * Build (from spike/newstack/):
 *   gcc -O0 -g stage5.c \
 *       -I../../drm \
 *       ../../drm/embedded_blobs/embedded_loader.o \
 *       ../../drm/embedded_blobs/libhybris-core.so.o \
 *       -ldl -lpthread -lm -o stage5
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dlfcn.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <errno.h>
#include "../../drm/embedded_loader.h"

/* ---- shims ---- */
static int shim_atfork(void(*a)(void),void(*b)(void),void(*c)(void),void*d)
{ (void)a;(void)b;(void)c;(void)d; return 0; }
static void *shim_memchr_chk(const void *s,int c,size_t n,size_t bs)
{ (void)bs; return (void *)memchr(s,c,n); }
static void *hook(const char *sym,const char *req){
    (void)req;
    if(!sym) return NULL;
    if(!strcmp(sym,"__register_atfork")) return (void*)shim_atfork;
    if(!strcmp(sym,"__memchr_chk"))      return (void*)shim_memchr_chk;
    return NULL;
}

/* ---- ADI C API typedefs ---- */
typedef int (*fn_path)(const char *);
typedef int (*fn_buf) (const uint8_t *,int);
typedef int (*fn_check)(int64_t);
typedef int (*fn_otp)  (int64_t,uint8_t**,int*,uint8_t**,int*);
typedef int (*fn_pstart)(int64_t,const uint8_t*,int,uint8_t**,int*,uint64_t*);
typedef int (*fn_pend)  (uint64_t,const uint8_t*,int,const uint8_t*,int);

/* ---- base64 ---- */
static const char B64[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void b64enc(const uint8_t *in,int len,char *out){
    int i=0,o=0;
    for(;i+2<len;i+=3){
        out[o++]=B64[(in[i]>>2)&63];
        out[o++]=B64[((in[i]&3)<<4)|((in[i+1]>>4)&15)];
        out[o++]=B64[((in[i+1]&15)<<2)|((in[i+2]>>6)&3)];
        out[o++]=B64[in[i+2]&63];
    }
    if(i<len){
        out[o++]=B64[(in[i]>>2)&63];
        if(i+1<len){ out[o++]=B64[((in[i]&3)<<4)|((in[i+1]>>4)&15)]; out[o++]=B64[((in[i+1]&15)<<2)]; }
        else        { out[o++]=B64[(in[i]&3)<<4]; out[o++]='='; }
        out[o++]='=';
    }
    out[o]='\0';
}

/* ---- simple base64 decode ---- */
static const signed char B64D[256]={
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
    52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
    -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
    15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
    -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
    41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1
};
static int b64dec(const char *s,uint8_t *out){
    int o=0,state=0,val=0;
    for(;*s&&*s!='=';s++){
        int v=B64D[(unsigned char)*s];
        if(v<0) continue;
        switch(state){
            case 0: val=v<<18; state=1; break;
            case 1: val|=v<<12; state=2; break;
            case 2: val|=v<<6;  state=3; break;
            case 3: val|=v;     out[o++]=(val>>16)&0xff; out[o++]=(val>>8)&0xff; out[o++]=val&0xff; state=0; break;
        }
    }
    if(state==2){ out[o++]=(val>>16)&0xff; }
    if(state==3){ out[o++]=(val>>16)&0xff; out[o++]=(val>>8)&0xff; }
    return o;
}

/* ---- read device-id from file (16 hex ASCII bytes) ---- */
static int read_device_id(const char *dir, uint8_t aid[16]){
    char path[512];
    snprintf(path,sizeof path,"%s/device-id",dir);
    FILE *f=fopen(path,"rb");
    if(!f){ fprintf(stderr,"open %s: %s\n",path,strerror(errno)); return -1; }
    int n=fread(aid,1,16,f); fclose(f);
    if(n!=16){ fprintf(stderr,"device-id: expected 16, got %d\n",n); return -1; }
    return 0;
}

/* =========================================================
 * PHASE A: child — load OLD stack, produce OTP, write to file
 * ========================================================= */
static int phase_a(const char *drm_dir, int64_t dsid, const char *out_file)
{
    setenv("HYBRIS_LINKER_DIR",     "../../drm/hybris-linker",1);
    setenv("HYBRIS_LD_LIBRARY_PATH","../../drm/rootfs/system/lib64",1);
    setenv("HYBRIS_ANDROID_LIB64", "../../drm/rootfs/system/lib64",1);
    setenv("ANDROID_ROOT","/tmp/stage5-old-root",0);
    setenv("ANDROID_DATA","/tmp/stage5-old-data",0);
    mkdir("/tmp/stage5-old-root",0755); mkdir("/tmp/stage5-old-data",0755);

    if(embedded_loader_init()!=0){
        fprintf(stderr,"[A] embedded_loader_init: %s\n",embedded_dlerror()); return 1;
    }
    embedded_set_hook_callback(hook);

    /* load old stack — only need libstoreservicescore */
    const char *libs[]={"libCoreFP.so","libCoreADI.so","libstoreservicescore.so",NULL};
    for(int i=0;libs[i];i++){
        if(!embedded_dlopen(libs[i],RTLD_NOW|RTLD_GLOBAL)){
            fprintf(stderr,"[A] %s: %s\n",libs[i],embedded_dlerror()); return 1;
        }
        printf("[A] loaded %s\n",libs[i]);
    }

    fn_path  adi_setpath=NULL, adi_load=NULL;
    fn_buf   adi_setid=NULL;
    fn_check adi_isprov=NULL;
    fn_otp   adi_otp=NULL;
#define SYM(v,n) *(void**)&v=embedded_dlsym(n); printf("[A]   %-30s %s\n",n,(void*)v?"ok":"MISSING");
    SYM(adi_setpath,"nf92ngaK92") SYM(adi_load,"kq56gsgHG6")
    SYM(adi_setid,  "Sph98paBcz") SYM(adi_isprov,"aslgmuibau")
    SYM(adi_otp,    "qi864985u0")
#undef SYM
    if(!adi_setpath||!adi_load||!adi_setid||!adi_isprov||!adi_otp){
        fputs("[A] missing symbols\n",stderr); return 1;
    }

    uint8_t aid[16];
    if(read_device_id(drm_dir,aid)!=0) return 1;

    int rc;
    rc=adi_setpath(drm_dir); printf("[A] ADISetProvisioningPath(%s) -> %d\n",drm_dir,rc);
    rc=adi_load(drm_dir);    printf("[A] ADILoadLibraryWithPath  -> %d\n",rc);
    rc=adi_setpath(drm_dir); printf("[A] ADISetProvisioningPath2 -> %d\n",rc);
    rc=adi_setid(aid,16);    printf("[A] ADISetAndroidID         -> %d\n",rc);

    rc=adi_isprov(dsid);
    printf("[A] ADIIsMachineProvisioned(%lld) -> %d (%s)\n",(long long)dsid,rc,
           rc==0?"PROVISIONED":"NOT PROVISIONED");
    if(rc!=0){
        /* try dsid=0 */
        rc=adi_isprov(0);
        printf("[A] ADIIsMachineProvisioned(0)  -> %d (%s)\n",rc,rc==0?"PROVISIONED":"NOT PROVISIONED");
        if(rc!=0){ fputs("[A] old stack not provisioned — cannot bootstrap\n",stderr); return 1; }
        dsid=0;
    }

    uint8_t *otp=NULL,*mid=NULL; int otpLen=0,midLen=0;
    rc=adi_otp(dsid,&otp,&otpLen,&mid,&midLen);
    printf("[A] ADIOTPRequest -> %d  otp=%d mid=%d\n",rc,otpLen,midLen);
    if(rc!=0||!otp||otpLen<=0){ fprintf(stderr,"[A] OTP failed (%d)\n",rc); return 1; }

    char otp_b64[2048], mid_b64[2048];
    b64enc(otp,otpLen,otp_b64);
    b64enc(mid,midLen,mid_b64);

    FILE *fp=fopen(out_file,"w");
    if(!fp){ perror(out_file); return 1; }
    fprintf(fp,"OTP=%s\nMID=%s\n",otp_b64,mid_b64);
    fclose(fp);
    printf("[A] wrote OTP headers to %s\n",out_file);
    return 0;
}

/* =========================================================
 * PHASE B: parent — provision 6.5.2 stack using real OTP
 * ========================================================= */
static int phase_b(const char *new_adi_dir, int64_t dsid, const char *otp_file)
{
    /* read OTP headers produced by phase A */
    char otp_b64[2048]="", mid_b64[2048]="";
    {
        FILE *fp=fopen(otp_file,"r");
        if(!fp){ perror(otp_file); return 1; }
        char line[2048];
        while(fgets(line,sizeof line,fp)){
            line[strcspn(line,"\r\n")]='\0';
            if(strncmp(line,"OTP=",4)==0) strncpy(otp_b64,line+4,sizeof otp_b64-1);
            if(strncmp(line,"MID=",4)==0) strncpy(mid_b64,line+4,sizeof mid_b64-1);
        }
        fclose(fp);
    }
    if(!otp_b64[0]||!mid_b64[0]){ fputs("[B] OTP file incomplete\n",stderr); return 1; }
    printf("[B] X-Apple-I-MD   = %.40s...\n",otp_b64);
    printf("[B] X-Apple-I-MD-M = %.40s...\n",mid_b64);

    /* ---- fetch GrandSlam bag ---- */
    char bag_file[256]; snprintf(bag_file,sizeof bag_file,"/tmp/stage5-gs-bag.plist");
    {
        char cmd[4096];
        /* try gsd first, then gsa */
        snprintf(cmd,sizeof cmd,
            "curl -s --insecure -f -X POST "
            "'https://gsd.apple.com/grandslam/GsService2/lookup/v2' "
            "-H 'X-Apple-I-MD: %s' "
            "-H 'X-Apple-I-MD-M: %s' "
            "-H 'X-MMe-Client-Info: <Pixel 7><Android; 14;441323.1><com.apple.android.music/6.5.2>' "
            "-H 'X-MMe-Device-Id: 5f9433575d1935bf' "
            "-H 'User-Agent: com.apple.android.music/6.5.2' "
            "-H 'Content-Type: text/x-xml-plist' "
            "--data-binary '' "
            "-o '%s' -w '%%{http_code}'",
            otp_b64,mid_b64,bag_file);
        FILE *p=popen(cmd,"r"); char hc[8]="???";
        if(p){ fgets(hc,sizeof hc,p); pclose(p); }
        printf("[B] GrandSlam gsd -> HTTP %s\n",hc);

        if(hc[0]!='2'){
            /* try gsa */
            snprintf(cmd,sizeof cmd,
                "curl -s --insecure -f -X POST "
                "'https://gsa.apple.com/grandslam/GsService2/lookup' "
                "-H 'X-Apple-I-MD: %s' "
                "-H 'X-Apple-I-MD-M: %s' "
                "-H 'X-MMe-Client-Info: <Pixel 7><Android; 14;441323.1><com.apple.android.music/6.5.2>' "
                "-H 'X-MMe-Device-Id: 5f9433575d1935bf' "
                "-H 'User-Agent: com.apple.android.music/6.5.2' "
                "-H 'Content-Type: text/x-xml-plist' "
                "--data-binary '' "
                "-o '%s' -w '%%{http_code}'",
                otp_b64,mid_b64,bag_file);
            p=popen(cmd,"r"); hc[0]='?';
            if(p){ fgets(hc,sizeof hc,p); pclose(p); }
            printf("[B] GrandSlam gsa -> HTTP %s\n",hc);
        }
    }

    /* ---- parse GrandSlam bag for provisioning URLs ---- */
    char start_url[512]="", finish_url[512]="";
    {
        /* also try iTunes bag as fallback */
        const char *plist_files[]={ bag_file,
            "/tmp/claude-1000/-home-daksh-Git-Projects-apple-music-linux/00f6bb53-6fb1-4f8a-b2a1-89e4cf2412cf/scratchpad/itunes-bag.plist",
            NULL };
        char py[4096];
        snprintf(py,sizeof py,
            "python3 -c \""
            "import plistlib,sys\n"
            "for path in %s:\n"
            "    try:\n"
            "        with open(path,'rb') as f: pl=plistlib.load(f)\n"
            "    except: continue\n"
            "    # check GrandSlam bag keys\n"
            "    for start_k in ['midStartProvisioning','aniSetupCertRequest','amd-start-provisioning']:\n"
            "        if start_k in pl: print('START='+pl[start_k]); break\n"
            "    for finish_k in ['midFinishProvisioning','amd-finish-provisioning','md-finish-provisioning']:\n"
            "        if finish_k in pl: print('FINISH='+pl[finish_k]); break\n"
            "    break\n"
            "\"",
            "['%s','%s']", bag_file,
            "/tmp/claude-1000/-home-daksh-Git-Projects-apple-music-linux/00f6bb53-6fb1-4f8a-b2a1-89e4cf2412cf/scratchpad/itunes-bag.plist");
        /* simpler inline python */
        snprintf(py,sizeof py,
            "python3 - <<'PYEOF'\n"
            "import plistlib\n"
            "paths = ['%s', '%s']\n"
            "for path in paths:\n"
            "    try:\n"
            "        f=open(path,'rb'); pl=plistlib.load(f); f.close()\n"
            "    except Exception as e:\n"
            "        print('skip',path,e); continue\n"
            "    for k in ['midStartProvisioning','aniSetupCertRequest']:\n"
            "        if k in pl:\n"
            "            print('START='+str(pl[k])); break\n"
            "    for k in ['midFinishProvisioning','amd-finish-provisioning','md-finish-provisioning']:\n"
            "        if k in pl:\n"
            "            print('FINISH='+str(pl[k])); break\n"
            "    break\n"
            "PYEOF",
            bag_file,
            "/tmp/claude-1000/-home-daksh-Git-Projects-apple-music-linux/00f6bb53-6fb1-4f8a-b2a1-89e4cf2412cf/scratchpad/itunes-bag.plist");
        printf("[B] parsing bags...\n");
        FILE *p=popen(py,"r"); char line[1024];
        if(p){
            while(fgets(line,sizeof line,p)){
                printf("[B]   %s",line);
                line[strcspn(line,"\r\n")]='\0';
                if(strncmp(line,"START=",6)==0) strncpy(start_url,line+6,sizeof start_url-1);
                if(strncmp(line,"FINISH=",7)==0) strncpy(finish_url,line+7,sizeof finish_url-1);
            }
            pclose(p);
        }
    }
    printf("[B] start_url  = %s\n", start_url[0]?start_url:"<not found>");
    printf("[B] finish_url = %s\n", finish_url[0]?finish_url:"<not found>");

    if(!finish_url[0]){ fputs("[B] no finish URL found\n",stderr); return 1; }

    /* ---- if we have a start URL, fetch SPIM ---- */
    uint8_t *spim=NULL; int spimLen=0;
    if(start_url[0]){
        char spim_file[256]; snprintf(spim_file,sizeof spim_file,"/tmp/stage5-spim.bin");
        char cmd[4096];
        snprintf(cmd,sizeof cmd,
            "curl -s --insecure -f -X POST '%s' "
            "-H 'X-Apple-I-MD: %s' "
            "-H 'X-Apple-I-MD-M: %s' "
            "-H 'X-MMe-Client-Info: <Pixel 7><Android; 14;441323.1><com.apple.android.music/6.5.2>' "
            "-H 'X-MMe-Device-Id: 5f9433575d1935bf' "
            "-H 'User-Agent: com.apple.android.music/6.5.2' "
            "-H 'Content-Type: text/x-xml-plist' "
            "--data-binary '' "
            "-o '%s' -w '%%{http_code}'",
            start_url,otp_b64,mid_b64,spim_file);
        FILE *p=popen(cmd,"r"); char hc[8]="???";
        if(p){ fgets(hc,sizeof hc,p); pclose(p); }
        printf("[B] start_provisioning -> HTTP %s\n",hc);
        if(hc[0]=='2'){
            FILE *f=fopen(spim_file,"rb");
            if(f){ fseek(f,0,SEEK_END); spimLen=(int)ftell(f); rewind(f);
                   spim=malloc(spimLen+1); fread(spim,1,spimLen,f); fclose(f); }
            printf("[B] SPIM size = %d bytes\n",spimLen);
        }
    } else {
        /* Some protocols don't need a server-side start:
         * try ADIProvisioningStart with spim=NULL,spimLen=0 — library may self-generate */
        printf("[B] no start URL; will try ADIProvisioningStart with spim=NULL\n");
        spim=NULL; spimLen=0;
    }

    /* ---- load 6.5.2 ADI stack ---- */
    printf("[B] loading 6.5.2 ADI stack...\n");
    setenv("HYBRIS_LINKER_DIR",     "../../drm/hybris-linker",1);
    setenv("HYBRIS_LD_LIBRARY_PATH","../../drm/rootfs-6.5.2/system/lib64",1);
    setenv("HYBRIS_ANDROID_LIB64", "../../drm/rootfs-6.5.2/system/lib64",1);
    setenv("ANDROID_ROOT","/tmp/stage5-new-root",0);
    setenv("ANDROID_DATA","/tmp/stage5-new-data",0);
    mkdir("/tmp/stage5-new-root",0755); mkdir("/tmp/stage5-new-data",0755);
    mkdir(new_adi_dir,0755);

    if(embedded_loader_init()!=0){
        fprintf(stderr,"[B] embedded_loader_init: %s\n",embedded_dlerror()); return 1;
    }
    embedded_set_hook_callback(hook);

    const char *libs[]={"libCoreFP.so","libCoreADI.so","libCoreLSKD.so",
                        "libFPDIFor3P.so","libstoreapi.so",NULL};
    for(int i=0;libs[i];i++){
        if(!embedded_dlopen(libs[i],RTLD_NOW|RTLD_GLOBAL)){
            fprintf(stderr,"[B] %s: %s\n",libs[i],embedded_dlerror()); return 1;
        }
        printf("[B] loaded %s\n",libs[i]);
    }

    fn_path   adi_setpath=NULL, adi_load=NULL;
    fn_buf    adi_setid=NULL;
    fn_check  adi_isprov=NULL;
    fn_otp    adi_otp=NULL;
    fn_pstart adi_pstart=NULL;
    fn_pend   adi_pend=NULL;
#define SYM(v,n) *(void**)&v=embedded_dlsym(n); printf("[B]   %-30s %s\n",n,(void*)v?"ok":"MISSING");
    SYM(adi_setpath,"nf92ngaK92") SYM(adi_load,"kq56gsgHG6")
    SYM(adi_setid,  "Sph98paBcz") SYM(adi_isprov,"aslgmuibau")
    SYM(adi_otp,    "qi864985u0") SYM(adi_pstart,"rsegvyrt87")
    SYM(adi_pend,   "uv5t6nhkui")
#undef SYM
    if(!adi_setpath||!adi_load||!adi_setid||!adi_isprov||!adi_pstart||!adi_pend){
        fputs("[B] missing symbols\n",stderr); return 1;
    }

    /* fresh Android ID for the new stack (or reuse existing — try both) */
    uint8_t aid[16];
    /* try using the same device-id as we have — maybe Apple will accept re-provisioning */
    /* For this spike we'll just generate a fresh random one to get a clean new adi.pb */
    FILE *rng=fopen("/dev/urandom","rb");
    if(rng){ fread(aid,1,16,rng); fclose(rng); }
    /* make it printable hex-ish so it can be stored as ASCII later */
    static const char hex[]="0123456789abcdef";
    for(int i=0;i<16;i++) aid[i]=hex[aid[i]&15];
    printf("[B] fresh Android ID: %.16s\n",aid);

    int rc;
    rc=adi_setpath(new_adi_dir); printf("[B] ADISetProvisioningPath(%s) -> %d\n",new_adi_dir,rc);
    rc=adi_load(new_adi_dir);    printf("[B] ADILoadLibraryWithPath     -> %d\n",rc);
    rc=adi_setpath(new_adi_dir); printf("[B] ADISetProvisioningPath2    -> %d\n",rc);
    rc=adi_setid(aid,16);        printf("[B] ADISetAndroidID            -> %d\n",rc);

    /* ADIProvisioningStart */
    uint8_t *cpim=NULL; int cpimLen=0; uint64_t session=0;
    rc=adi_pstart(0, spim, spimLen, &cpim, &cpimLen, &session);
    printf("[B] ADIProvisioningStart(dsid=0,spim=%p,spimLen=%d) -> %d  cpimLen=%d session=%llu\n",
           (void*)spim,spimLen,rc,cpimLen,(unsigned long long)session);
    free(spim); spim=NULL;

    if(rc!=0||!cpim||cpimLen<=0){
        fprintf(stderr,"[B] ADIProvisioningStart failed (rc=%d)\n",rc);
        /* if spim was NULL and it failed, we need a real start URL — report and bail */
        fputs("[B] Need a valid SPIM from midStartProvisioning endpoint\n",stderr);
        return 1;
    }

    /* encode cpim as base64 for plist POST */
    char cpim_b64[8192]; b64enc(cpim,cpimLen,cpim_b64);
    printf("[B] CPIM size=%d b64len=%zu\n",cpimLen,strlen(cpim_b64));

    /* POST cpim to finish URL */
    char ptm_file[256]; snprintf(ptm_file,sizeof ptm_file,"/tmp/stage5-ptmtk.bin");
    {
        /* Build plist body: <?xml ...> <dict><key>cpim</key><data>base64</data></dict> */
        char body[16384];
        int blen=snprintf(body,sizeof body,
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
            "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
            "<plist version=\"1.0\"><dict>"
            "<key>cpim</key><data>%s</data>"
            "</dict></plist>",
            cpim_b64);

        /* write body to temp file */
        char body_file[256]; snprintf(body_file,sizeof body_file,"/tmp/stage5-cpim-body.plist");
        FILE *f=fopen(body_file,"w");
        if(f){ fwrite(body,1,blen,f); fclose(f); }

        char cmd[4096];
        snprintf(cmd,sizeof cmd,
            "curl -s --insecure -f -X POST '%s' "
            "-H 'X-Apple-I-MD: %s' "
            "-H 'X-Apple-I-MD-M: %s' "
            "-H 'X-MMe-Client-Info: <Pixel 7><Android; 14;441323.1><com.apple.android.music/6.5.2>' "
            "-H 'X-MMe-Device-Id: 5f9433575d1935bf' "
            "-H 'User-Agent: com.apple.android.music/6.5.2' "
            "-H 'Content-Type: text/x-xml-plist' "
            "--data-binary '@%s' "
            "-o '%s' -w '%%{http_code}'",
            finish_url,otp_b64,mid_b64,body_file,ptm_file);
        FILE *p=popen(cmd,"r"); char hc[8]="???";
        if(p){ fgets(hc,sizeof hc,p); pclose(p); }
        printf("[B] finish_provisioning -> HTTP %s\n",hc);
        if(hc[0]!='2'){
            fprintf(stderr,"[B] finish provisioning failed HTTP %s\n",hc);
            /* show response */
            system("cat /tmp/stage5-ptmtk.bin 2>/dev/null | head -20");
            return 1;
        }
    }

    /* parse ptm/tk from response plist */
    uint8_t *ptm=NULL,*tk=NULL; int ptmLen=0,tkLen=0;
    {
        char py[2048];
        snprintf(py,sizeof py,
            "python3 -c \""
            "import plistlib,base64,sys\n"
            "f=open('%s','rb'); pl=plistlib.load(f); f.close()\n"
            "ptm=pl.get('ptm') or pl.get('p',b'')\n"
            "tk=pl.get('tk') or pl.get('t',b'')\n"
            "if isinstance(ptm,bytes): print('PTM='+base64.b64encode(ptm).decode())\n"
            "if isinstance(tk,bytes):  print('TK='+base64.b64encode(tk).decode())\n"
            "\"",ptm_file);
        FILE *p=popen(py,"r"); char line[4096];
        char ptm_b64[4096]="",tk_b64[4096]="";
        if(p){
            while(fgets(line,sizeof line,p)){
                printf("[B] plist: %s",line);
                line[strcspn(line,"\r\n")]='\0';
                if(strncmp(line,"PTM=",4)==0) strncpy(ptm_b64,line+4,sizeof ptm_b64-1);
                if(strncmp(line,"TK=",3)==0)  strncpy(tk_b64,line+3,sizeof tk_b64-1);
            }
            pclose(p);
        }
        if(!ptm_b64[0]||!tk_b64[0]){
            fputs("[B] no ptm/tk in response — dumping:\n",stderr);
            system("cat /tmp/stage5-ptmtk.bin | head -30");
            return 1;
        }
        ptm=malloc(strlen(ptm_b64)); ptmLen=b64dec(ptm_b64,ptm);
        tk =malloc(strlen(tk_b64));  tkLen =b64dec(tk_b64,tk);
    }
    printf("[B] PTM size=%d  TK size=%d\n",ptmLen,tkLen);

    /* ADIProvisioningEnd */
    rc=adi_pend(session,ptm,ptmLen,tk,tkLen);
    printf("[B] ADIProvisioningEnd -> %d (%s)\n",rc,rc==0?"OK":"FAILED");
    free(ptm); free(tk); free(cpim);
    if(rc!=0){ fprintf(stderr,"[B] ADIProvisioningEnd failed\n"); return 1; }

    /* verify */
    rc=adi_isprov(0);
    printf("[B] ADIIsMachineProvisioned(0) -> %d (%s)\n",rc,rc==0?"PROVISIONED ✓":"still not provisioned?");

    if(rc==0){
        /* generate and print OTP with new stack */
        uint8_t *otp2=NULL,*mid2=NULL; int otp2Len=0,mid2Len=0;
        rc=adi_otp(0,&otp2,&otp2Len,&mid2,&mid2Len);
        if(rc==0&&otp2){
            char ob[2048],mb[2048];
            b64enc(otp2,otp2Len,ob); b64enc(mid2,mid2Len,mb);
            printf("\n=== NEW ANISETTE HEADERS (6.5.2 stack) ===\n");
            printf("X-Apple-I-MD:   %s\n",ob);
            printf("X-Apple-I-MD-M: %s\n",mb);
        }
        /* save new device-id */
        char did_path[512]; snprintf(did_path,sizeof did_path,"%s/device-id",new_adi_dir);
        FILE *f=fopen(did_path,"w");
        if(f){ fwrite(aid,1,16,f); fclose(f);
               printf("[B] saved new device-id to %s\n",did_path); }
        printf("[B] ✅ 6.5.2 ADI provisioned in %s\n",new_adi_dir);
    }
    return rc==0?0:1;
}

/* ===== main ===== */
int main(int argc, char **argv)
{
    const char *drm_dir  = argc>1 ? argv[1] : "../../drm/files";
    const char *new_dir  = argc>2 ? argv[2] : "/tmp/stage5-new-adi";
    int64_t dsid         = argc>3 ? atoll(argv[3]) : 21997672533LL;

    printf("=== Stage 5: Bootstrap 6.5.2 ADI provisioning ===\n");
    printf("  OLD drm dir : %s\n", drm_dir);
    printf("  NEW adi dir : %s\n", new_dir);
    printf("  DSID        : %lld\n",(long long)dsid);
    mkdir(new_dir,0755);

    /* Phase A runs in a child so it can init the embedded_loader independently */
    const char *otp_file="/tmp/stage5-otp.txt";
    pid_t pid=fork();
    if(pid==0){
        /* child */
        int r=phase_a(drm_dir,dsid,otp_file);
        exit(r);
    } else if(pid<0){
        perror("fork"); return 1;
    }
    int status=0;
    waitpid(pid,&status,0);
    if(!WIFEXITED(status)||WEXITSTATUS(status)!=0){
        fprintf(stderr,"Phase A failed (status=%d)\n",WEXITSTATUS(status)); return 1;
    }
    printf("\n--- Phase A complete ---\n\n");

    return phase_b(new_dir,dsid,otp_file);
}

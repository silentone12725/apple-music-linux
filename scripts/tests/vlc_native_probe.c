// Offline fixture probe only. No application hooks or audio-output replacement.
#include <vlc/vlc.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#define CAP 4096
struct row { double at; unsigned seq, generation; int event, state, eof, failed; int64_t media, length; };
struct source { unsigned char *data; size_t size, offset; unsigned generation; atomic_int eof, failed, ended, errored; int failure; };
static struct row rows[CAP];
static atomic_uint count;
static struct timespec origin;
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return (t.tv_sec-origin.tv_sec)*1000.0+(t.tv_nsec-origin.tv_nsec)/1e6; }
static void record(struct source *s,int event,int state,int64_t media,int64_t length) {
    unsigned i=atomic_fetch_add(&count,1); if(i>=CAP) return;
    rows[i]=(struct row){now_ms(),i+1,s->generation,event,state,atomic_load(&s->eof),atomic_load(&s->failed),media,length};
}
// Callback: no libVLC calls, allocation, locks, file I/O or player mutation.
static void event_cb(const libvlc_event_t *e,void *opaque) {
    struct source *s=opaque; int state=-1; int64_t media=-1,length=-1;
    switch(e->type) {
    case libvlc_MediaPlayerTimeChanged: media=e->u.media_player_time_changed.new_time; break;
    case libvlc_MediaPlayerLengthChanged: length=e->u.media_player_length_changed.new_length; break;
    case libvlc_MediaPlayerPlaying: state=libvlc_Playing; break;
    case libvlc_MediaPlayerPaused: state=libvlc_Paused; break;
    case libvlc_MediaPlayerStopped: state=libvlc_Stopped; break;
    case libvlc_MediaPlayerEndReached: state=libvlc_Ended; break;
    case libvlc_MediaPlayerEncounteredError: state=libvlc_Error; break;
    }
    record(s,e->type,state,media,length);
    if(e->type==libvlc_MediaPlayerEncounteredError) atomic_store(&s->errored,1);
    if(e->type==libvlc_MediaPlayerEndReached) atomic_store(&s->ended,1);
}
static int open_cb(void *opaque,void **data,uint64_t *size) {
    struct source *s=opaque; s->offset=0; *data=s; *size=s->size; atomic_store(&s->eof,0); return 0;
}
static ssize_t read_cb(void *opaque,unsigned char *buf,size_t size) {
    struct source *s=opaque;
    if(s->failure && s->offset>=s->size/2){atomic_store(&s->failed,1);record(s,10007,-1,-1,-1);return -1;}
    size_t n=s->size-s->offset; if(n>size)n=size;
    if(n) { memcpy(buf,s->data+s->offset,n); s->offset+=n; return (ssize_t)n; }
    if(!atomic_exchange(&s->eof,1)) record(s,10001,-1,-1,-1);
    return 0;
}
static int seek_cb(void *opaque,uint64_t offset) {
    struct source *s=opaque; if(offset>s->size)return -1; s->offset=(size_t)offset; atomic_store(&s->eof,0); return 0;
}
static void close_cb(void *opaque) { record(opaque,10002,-1,-1,-1); }
int main(int argc,char **argv) {
    if(!getenv("PLAYBACK01_NATIVE_PROBE") || strcmp(getenv("PLAYBACK01_NATIVE_PROBE"),"1")) return 77;
    if(argc<3)return 64;
    if(!atomic_is_lock_free(&count))return 68;
    FILE *f=fopen(argv[1],"rb"); if(!f)return 65;
    fseek(f,0,SEEK_END); long size=ftell(f); rewind(f);
    if(size<=0){fclose(f);return 65;}
    unsigned char *bytes=malloc((size_t)size); if(!bytes)return 66;
    if(fread(bytes,1,(size_t)size,f)!=(size_t)size){fclose(f);free(bytes);return 65;} fclose(f);
    clock_gettime(CLOCK_MONOTONIC,&origin);
    const char *options[]={"--quiet","--vout=dummy"};
    libvlc_instance_t *instance=libvlc_new(2,options); if(!instance){free(bytes);return 67;}
    libvlc_set_app_id(instance,"local.adam.playback01.probe","1","adam");
    libvlc_media_player_t *player=libvlc_media_player_new(instance);
    if(!player){libvlc_release(instance);free(bytes);return 67;}
    libvlc_audio_set_volume(player,0);
    libvlc_event_manager_t *manager=libvlc_media_player_event_manager(player);
    const int types[]={libvlc_MediaPlayerPlaying,libvlc_MediaPlayerPaused,libvlc_MediaPlayerStopped,
        libvlc_MediaPlayerEndReached,libvlc_MediaPlayerEncounteredError,libvlc_MediaPlayerTimeChanged,
        libvlc_MediaPlayerLengthChanged,libvlc_MediaPlayerBuffering};
    int lifecycle=argc>3 && !strcmp(argv[3],"lifecycle"), ok=1;
    int seek_mode=argc>3 && !strcmp(argv[3],"seek"), failure_mode=argc>3 && !strcmp(argv[3],"failure");
    // No seek callback: imem reports neither seekable nor pace-controllable.
    int nonseek=argc>3 && !strcmp(argv[3],"nonseek");
    libvlc_media_stats_t stats[3]={0}; int stats_valid[3]={0};
    struct source sources[3]={0};
    for(unsigned gen=0;gen<(lifecycle?3u:1u);gen++) {
        struct source *s=&sources[gen]; s->data=bytes;s->size=(size_t)size;s->generation=gen+1;s->failure=failure_mode;
        libvlc_media_t *media=libvlc_media_new_callbacks(instance,open_cb,read_cb,nonseek?NULL:seek_cb,close_cb,s);
        if(!media){ok=0;break;}
        libvlc_media_player_set_media(player,media);
        unsigned attached=0;
        for(size_t j=0;j<sizeof(types)/sizeof(types[0]);j++) {
            if(libvlc_event_attach(manager,types[j],event_cb,s)!=0)ok=0;
            else attached |= 1u << j;
        }
        if(libvlc_media_player_play(player)!=0)ok=0;
        double start=now_ms(); int paused=0,seeked=0;
        while(ok && !atomic_load(&s->ended) && !atomic_load(&s->errored) && now_ms()-start<atof(argv[2])*1000) {
            record(s,10000,libvlc_media_player_get_state(player),libvlc_media_player_get_time(player),libvlc_media_player_get_length(player));
            if(seek_mode && !seeked && now_ms()-start>250 && libvlc_media_player_get_state(player)==libvlc_Playing){libvlc_media_player_set_time(player,3000);record(s,10005,-1,3000,-1);seeked=1;}
            if(lifecycle && !paused && now_ms()-start>250){libvlc_media_player_set_pause(player,1);usleep(100000);libvlc_media_player_set_pause(player,0);paused=1;}
            if(lifecycle && now_ms()-start>750)break;
            usleep(250000);
        }
        if(!lifecycle){if(failure_mode)ok=ok && atomic_load(&s->failed) && (atomic_load(&s->ended)||atomic_load(&s->errored));else ok=ok && atomic_load(&s->ended) && !atomic_load(&s->errored);}
        record(s,10000,libvlc_media_player_get_state(player),libvlc_media_player_get_time(player),libvlc_media_player_get_length(player));
        stats_valid[gen]=libvlc_media_get_stats(media,&stats[gen]);
        // Stop joins input/source callbacks; detach subscriptions before replacement.
        // Source contexts and backing bytes stay alive through final player release.
        libvlc_media_player_stop(player);
        for(size_t j=0;j<sizeof(types)/sizeof(types[0]);j++)if(attached & (1u << j))libvlc_event_detach(manager,types[j],event_cb,s);
        libvlc_media_player_set_media(player,NULL);libvlc_media_release(media);
    }
    libvlc_media_player_release(player);libvlc_release(instance);free(bytes);
    unsigned total=atomic_load(&count),n=total<CAP?total:CAP;
    printf("{\"ok\":%s,\"capacity\":%d,\"dropped\":%u,\"events\":[",ok?"true":"false",CAP,total-n);
    for(unsigned i=0;i<n;i++){struct row *r=&rows[i];printf("%s{\"sequence\":%u,\"generation\":%u,\"atMs\":%.3f,\"eventType\":%d,\"state\":%d,\"mediaTimeMs\":%lld,\"lengthMs\":%lld,\"eof\":%s,\"failed\":%s}",i?",":"",r->seq,r->generation,r->at,r->event,r->state,(long long)r->media,(long long)r->length,r->eof?"true":"false",r->failed?"true":"false");}
    printf("],\"stats\":[");
    for(unsigned g=0;g<(lifecycle?3u:1u);g++)printf("%s{\"generation\":%u,\"valid\":%s,\"decodedAudio\":%d,\"playedAudioBuffers\":%d,\"lostAudioBuffers\":%d,\"demuxCorrupted\":%d}",g?",":"",g+1,stats_valid[g]?"true":"false",stats[g].i_decoded_audio,stats[g].i_played_abuffers,stats[g].i_lost_abuffers,stats[g].i_demux_corrupted);
    puts("]}");return ok?0:2;
}

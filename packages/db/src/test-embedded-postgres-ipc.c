#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
typedef struct { int32_t magic; pid_t creator; size_t total,free_offset; uint32_t dsm; void *index; dev_t device; ino_t inode; } PgHeader;
_Static_assert(sizeof(PgHeader)==56,"unsupported ABI");
static void fail(const char *s){fprintf(stderr,"%s errno=%d\n",s,errno);exit(2);}
static long long number(char *s){char *e;errno=0;long long n=strtoll(s,&e,10);if(errno||!*s||*e||n<0)fail("invalid number");return n;}
static int gone(pid_t p){errno=0;return p>1&&kill(p,0)<0&&errno==ESRCH;}
static void emit(int id,struct shmid_ds *s){printf("{\"id\":%d,\"uid\":%u,\"cuid\":%u,\"key\":%d,\"size\":%zu,\"nattch\":%u,\"cpid\":%d,\"lpid\":%d,\"mode\":%u,\"seq\":%u,\"ctime\":%lld,\"atime\":%lld,\"dtime\":%lld}\n",id,s->shm_perm.uid,s->shm_perm.cuid,s->shm_perm._key,s->shm_segsz,s->shm_nattch,s->shm_cpid,s->shm_lpid,(unsigned)s->shm_perm.mode,(unsigned)s->shm_perm._seq,(long long)s->shm_ctime,(long long)s->shm_atime,(long long)s->shm_dtime);fflush(stdout);}
int main(int argc,char **argv){
 if(argc==3&&!strcmp(argv[1],"lease")){
  int fd=open(argv[2],O_RDWR|O_CREAT|O_NOFOLLOW,0600);if(fd<0)fail("lease open");
  struct stat st;if(fstat(fd,&st)<0||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||(st.st_mode&0777)!=0600)fail("lease identity");
  if(flock(fd,LOCK_EX|LOCK_NB)<0)fail("isolated database already reserved");
  puts("leased");fflush(stdout);char byte;while(read(STDIN_FILENO,&byte,1)>0){}
  close(fd);return 0;
 }
 if(argc==3&&!strcmp(argv[1],"probe")){
  int fd=open(argv[2],O_WRONLY|O_CREAT|O_EXCL,0600);if(fd<0)fail("probe receipt");
  if(dup2(fd,STDOUT_FILENO)<0)fail("probe receipt fd");close(fd);
  int own=shmget(IPC_PRIVATE,56,IPC_CREAT|0600);if(own<0)fail("capacity exhausted");
  struct shmid_ds s;if(shmctl(own,IPC_STAT,&s)<0){printf("{\"createdId\":%d,\"statFailed\":true}\n",own);fflush(stdout);fsync(1);fail("probe identity unknown; retain");}
  emit(own,&s);fsync(1);
  void *p=shmat(own,NULL,SHM_RDONLY);int attachError=p==(void*)-1?errno:0;
  int detachError=0;if(!attachError&&shmdt(p)<0)detachError=errno;
  int removeError=0;if(shmctl(own,IPC_RMID,NULL)<0)removeError=errno;
  int remains=shmctl(own,IPC_STAT,&s)==0;
  printf("{\"createdId\":%d,\"attachError\":%d,\"detachError\":%d,\"removeError\":%d,\"remains\":%s}\n",own,attachError,detachError,removeError,remains?"true":"false");fflush(stdout);fsync(1);
  return attachError||detachError||removeError||remains?2:0;
 }
 if(argc<3)return 64;
 long long parsed=number(argv[2]);if(parsed>INT32_MAX)return 64;
 int id=(int)parsed;struct shmid_ds s,t;
 if(shmctl(id,IPC_STAT,&s)<0)fail("stat");emit(id,&s);
 if(!strcmp(argv[1],"stat"))return 0;
 if(argc==3&&!strcmp(argv[1],"inspect")){
  if(id==150208515||s.shm_perm.uid!=getuid()||s.shm_perm.cuid!=getuid()||s.shm_nattch||s.shm_segsz!=56||!gone(s.shm_cpid))fail("inspect refused");
  void *p=shmat(id,NULL,SHM_RDONLY);if(p==(void*)-1)fail("inspect attach");PgHeader h;memcpy(&h,p,sizeof(h));if(shmdt(p)<0)fail("inspect detach");
  printf("{\"magic\":%d,\"creator\":%d,\"device\":%d,\"inode\":%llu,\"dsm\":%u}\n",h.magic,h.creator,h.device,(unsigned long long)h.inode,h.dsm);return 0;
 }
 if(argc!=9||strcmp(argv[1],"remove"))return 64;
 /* Expected complete kernel identity and PostgreSQL datadir identity. Never touch production. */
 if(id==150208515||s.shm_perm.uid!=getuid()||s.shm_perm.cuid!=getuid()||s.shm_nattch||s.shm_segsz!=56||s.shm_perm._key!=number(argv[3])||s.shm_ctime!=number(argv[4])||s.shm_cpid!=number(argv[5])||!gone(s.shm_cpid))fail("identity/owner/attachment/creator mismatch");
 void *p=shmat(id,NULL,SHM_RDONLY);if(p==(void*)-1)fail("readonly attach");
 PgHeader h;memcpy(&h,p,sizeof(h));
 if(shmdt(p)<0)fail("detach");
 if(h.magic!=679834894||h.creator!=s.shm_cpid||h.device!=number(argv[6])||h.inode!=(ino_t)number(argv[7])||h.dsm!=number(argv[8]))fail("PostgreSQL provenance mismatch");
 if(shmctl(id,IPC_STAT,&t)<0)fail("restat");
 if(t.shm_perm.mode!=s.shm_perm.mode||t.shm_perm._seq!=s.shm_perm._seq||t.shm_perm._key!=s.shm_perm._key||t.shm_perm.uid!=s.shm_perm.uid||t.shm_perm.cuid!=s.shm_perm.cuid||t.shm_ctime!=s.shm_ctime||t.shm_cpid!=s.shm_cpid||t.shm_segsz!=s.shm_segsz||t.shm_nattch||t.shm_lpid!=getpid()||!gone(t.shm_cpid))fail("changed during inspection");
 if(shmctl(id,IPC_RMID,NULL)<0)fail("remove");
 errno=0;if(shmctl(id,IPC_STAT,&t)==0||!(errno==EINVAL||errno==EIDRM))fail("removal unconfirmed");
 printf("{\"removed\":%d,\"magic\":%d,\"device\":%d,\"inode\":%llu,\"dsm\":%u}\n",id,h.magic,h.device,(unsigned long long)h.inode,h.dsm);return 0;
}

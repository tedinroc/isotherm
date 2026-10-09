# TEST ONLY: an Ubuntu 24.04 "VPS" with systemd as PID 1, sshd and a non-root user, used by run-container-tests.sh.
# The user has passwordless sudo here so the rehearsal runs unattended; on a real VPS sudo asks for the password.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends systemd systemd-sysv dbus dbus-user-session sudo openssh-server \
      ca-certificates curl iproute2 shellcheck \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash isotherm \
 && echo 'isotherm ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/isotherm-test && chmod 440 /etc/sudoers.d/isotherm-test \
 && install -d -m 700 -o isotherm -g isotherm /home/isotherm/.ssh \
 && printf 'PasswordAuthentication no\nPermitUserEnvironment yes\n' >/etc/ssh/sshd_config.d/isotherm-test.conf \
 && systemctl enable ssh \
 && systemctl mask getty@.service console-getty.service systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

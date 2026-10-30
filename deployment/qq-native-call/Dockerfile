ARG NAPCAT_BASE
FROM ${NAPCAT_BASE}
USER root
COPY ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's@http://deb.debian.org@https://mirrors.aliyun.com@g' /etc/apt/sources.list.d/debian.sources && apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=1 -o Acquire::http::Timeout=25 -o Acquire::https::Timeout=25 update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils xvfb xauth python3 libgtk-3-0 libnss3 libgbm1 libasound2 libnotify4 libsecret-1-0 libatspi2.0-0 libxss1 libxtst6 fonts-wqy-zenhei curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 2 --connect-timeout 20 --max-time 600 'https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_3.2.34-53644_amd64.deb' -o /tmp/linuxqq.deb && dpkg-deb -x /tmp/linuxqq.deb /tmp/qq-package && cp -a /tmp/qq-package/opt/QQ /opt/QQ && rm -rf /tmp/qq-package /tmp/linuxqq.deb && test -f /opt/QQ/resources/app/avsdk/libAVSDKPlugin.so
RUN apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=1 -o Acquire::https::Timeout=25 update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libpulse-mainloop-glib0 libegl1 libopengl0 && rm -rf /var/lib/apt/lists/* && LD_LIBRARY_PATH=/opt/QQ/resources/app/avsdk:/opt/QQ/resources/app/avsdk/bugly ldd /opt/QQ/resources/app/avsdk/libAVSDKPlugin.so > /tmp/avsdk.ldd && ! grep -q 'not found' /tmp/avsdk.ldd && ldd /opt/QQ/qq > /tmp/qq.ldd && ! grep -q 'not found' /tmp/qq.ldd
RUN python3 -c "import pathlib,json; p=pathlib.Path('/opt/QQ/resources/app/package.json'); c=json.loads(p.read_text());c['main']='./loadNapCat.js';p.write_text(json.dumps(c)); pathlib.Path('/opt/QQ/resources/app/loadNapCat.js').write_text(\"import('file:///app/napcat/napcat.mjs');\\n\")"
COPY bridge /call-source
COPY LICENSE /call-source/LICENSE
COPY allow-reviewed-plugin.py /call/allow-reviewed-plugin.py
RUN python3 /call/allow-reviewed-plugin.py /app/napcat/napcat.mjs
COPY run.sh /call/run.sh
RUN mkdir -p /app/napcat/plugins /app/napcat/config /app/napcat/cache /app/napcat/logs && bash /call-source/scripts/install.sh --qq-dir /opt/QQ --napcat-dir /app/napcat --install-dir /call && chown -R 998:998 /call /app/napcat/plugins/napcat-plugin-maibot-qq-voice-call && chown -R 998:998 /app/napcat/cache /app/napcat/logs && chmod 0755 /call-source
ENV HOME=/app MAIBOT_QQ_CALL_BRIDGE_DIR=/call MAIBOT_QQ_CALL_QQ_DIR=/opt/QQ MAIBOT_QQ_CALL_NAPCAT_DIR=/app/napcat MAIBOT_QQ_CALL_BRIDGE_TOKEN_FILE=/call/runtime/control.token
RUN (getent group 998 || groupadd -g 998 qqbridgeav) && (getent passwd 998 || useradd --no-log-init -u 998 -g 998 -d /app qqbridgeav) && mkdir -p /app/.config && chown 998:998 /app /app/.config
RUN usermod -d /app "$(getent passwd 998 | cut -d: -f1)" && mkdir -p /app/.cache && chown 998:998 /app/.cache
ENV XDG_CACHE_HOME=/app/.cache XDG_CONFIG_HOME=/app/.config
USER 998:998
ENTRYPOINT ["bash", "/call/scripts/run-av-host.sh"]

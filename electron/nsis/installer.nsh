; Windows: list Adam under Settings -> Apps -> Default apps -> "Choose defaults by link type" for adam:// and
; every Apple Music scheme Adam can open (the list matches APPLE_SCHEMES in deeplink.mjs; a test keeps them in sync).
; This only makes Adam selectable: Windows does not let an app take a link type silently, and Settings -> Links in
; the app still decides which schemes Adam registers itself for.

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\AdamURL" "" "Adam link"
  WriteRegStr SHCTX "Software\Classes\AdamURL" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\AdamURL\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\AdamURL\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Adam\Capabilities" "ApplicationName" "Adam"
  WriteRegStr SHCTX "Software\Adam\Capabilities" "ApplicationDescription" "Apple Music desktop client"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "adam" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "music" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "musics" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itms" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itmss" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itals" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "italss" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itvls" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itvlss" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itsradio" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunesradio" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "daap" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itpc" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.daap" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.itals" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.italss" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.itls" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.itlss" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.itms" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.itmss" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.itpc" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.itsradio" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.itvls" "AdamURL"
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "itunes.assocprotocol.itvlss" "AdamURL"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Adam" "Software\Adam\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Adam"
  DeleteRegKey SHCTX "Software\Adam"
  DeleteRegKey SHCTX "Software\Classes\AdamURL"
!macroend

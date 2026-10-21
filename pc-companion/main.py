"""Entry point of the packaged app: the companion window, or one of the Windows installer's update tasks."""

import sys

UPDATE_SERVICE_ARGUMENTS = ("--update-service", "--install-updater", "--remove-updater")


def main():
    if any(argument in sys.argv for argument in UPDATE_SERVICE_ARGUMENTS):
        import update_service

        sys.exit(update_service.main(sys.argv[1:]))
    import companion_ui

    companion_ui.main()


if __name__ == "__main__":
    main()
